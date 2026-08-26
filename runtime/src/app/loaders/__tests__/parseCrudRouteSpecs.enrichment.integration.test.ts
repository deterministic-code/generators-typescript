import { readFile } from 'node:fs/promises';
import path from 'node:path';

import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { buildBodySchema, parseCrudRouteSpecs } from '../parseCrudRouteSpecs';

const SAMPLE_DIR = path.resolve(
  __dirname,
  '../../../../../test-samples/kitchen-sink/deterministic',
);

async function loadYaml(file: string): Promise<unknown> {
  return yaml.load(await readFile(path.join(SAMPLE_DIR, file), 'utf8'));
}

async function loadKitchenSinkSpecs() {
  const datasourceDoc = await loadYaml('types.yaml');
  const routesDoc = await loadYaml('routes.yaml');
  const viewTypesDoc = await loadYaml('view_types.yaml');
  return parseCrudRouteSpecs(datasourceDoc, routesDoc, { viewTypesDoc });
}

describe('parseCrudRouteSpecs nested enrichment (kitchen-sink YAML)', () => {
  it('widget.notes direct-FK child carries childEnrichmentColumns=["widget_name","widget_status_name"]', async () => {
    const specs = await loadKitchenSinkSpecs();
    const widgetSpec = specs.find((s) => s.entityName === 'widget');
    const notesChild = widgetSpec?.eagerWriteChildren?.find((c) => c.fieldName === 'notes');

    expect(notesChild).toBeDefined();
    expect(notesChild?.kind).toBe('direct-fk');
    expect(notesChild?.childTable).toBe('widget_note');
    expect([...(notesChild?.childEnrichmentColumns ?? [])].sort()).toEqual([
      'widget_name',
      'widget_status_name',
    ]);
  });

  it('widget.categories (M2M) is read-eager only: it is absent from eagerWriteChildren, which holds just the direct-FK notes child', async () => {
    const specs = await loadKitchenSinkSpecs();
    const widgetSpec = specs.find((s) => s.entityName === 'widget');

    const childFieldNames = (widgetSpec?.eagerWriteChildren ?? []).map((c) => c.fieldName);
    expect(childFieldNames).toEqual(['notes']);
    expect(childFieldNames).not.toContain('categories');
    expect(widgetSpec?.eagerWriteChildren?.every((c) => c.kind === 'direct-fk')).toBe(true);
  });

  function widgetBodyBase() {
    return {
      name: 'perf-widget-name-abc',
      widget_status_id: 2,
      notes: [
        {
          body: 'perf-note-body-abc',
          widget_status_name: 'active',
        },
      ],
    };
  }

  it('POST /api/widgets body with nested notes[].widget_status_name parses successfully', async () => {
    const specs = await loadKitchenSinkSpecs();
    const widgetSpec = specs.find((s) => s.entityName === 'widget');
    const schema = buildBodySchema(widgetSpec!, 'create');

    const result = schema.safeParse(widgetBodyBase());
    if (!result.success) {
      throw new Error(`expected parse to succeed, got: ${JSON.stringify(result.error.issues)}`);
    }
    expect(result.success).toBe(true);
  });

  it('POST /api/widgets body with an unknown key on a nested note fails with notes.0 unrecognized_keys', async () => {
    const specs = await loadKitchenSinkSpecs();
    const widgetSpec = specs.find((s) => s.entityName === 'widget');
    const schema = buildBodySchema(widgetSpec!, 'create');

    const body = { ...widgetBodyBase(), notes: [{ ...widgetBodyBase().notes[0], evil_field: 'reject-me' }] };

    const result = schema.safeParse(body);
    expect(result.success).toBe(false);
    if (result.success) return;

    const matching = result.error.issues.filter(
      (issue) =>
        issue.code === 'unrecognized_keys' &&
        issue.path.length >= 2 &&
        issue.path[0] === 'notes' &&
        issue.path[1] === 0,
    );
    expect(matching.length).toBeGreaterThan(0);
    expect(matching.some((i) => (i as { keys?: string[] }).keys?.includes('evil_field'))).toBe(
      true,
    );
  });

  it.todo(
    'm2m positive enrichment: no current sample exercises M2M target with FK to readonly-lookup',
  );
});
