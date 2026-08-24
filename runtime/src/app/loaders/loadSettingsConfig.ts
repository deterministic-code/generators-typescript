import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { pathExists } from '../../repositories/pathExists';

export interface SettingsConfig {
  pluralizeTableNames: boolean;
  /** When true, PUT/PATCH/DELETE require `If-Match` (428 without it, 412 on a stale token). Lookup and M2M skip this even when the flag is on. Omitted/false keeps current non-OCC behavior. */
  useOptimisticConcurrency?: boolean;
}

function readOptionalBoolean(
  datasource: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = datasource[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') {
    throw new Error(
      `settings.yaml: 'settings.datasource.${key}' must be a boolean, got ${typeof raw} (${JSON.stringify(raw)})`,
    );
  }
  return raw;
}

function readDatasourceMapping(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') {
    throw new Error(`settings.yaml: expected top-level mapping, got ${typeof raw}`);
  }
  const settings = (raw as { settings?: unknown }).settings;
  if (settings === undefined) return null;
  if (settings === null || typeof settings !== 'object') {
    throw new Error(
      `settings.yaml: expected 'settings' to be a mapping, got ${settings === null ? 'null' : typeof settings}`,
    );
  }
  const datasource = (settings as { datasource?: unknown }).datasource;
  if (datasource === undefined) return null;
  if (datasource === null || typeof datasource !== 'object') {
    throw new Error(
      `settings.yaml: expected 'settings.datasource' to be a mapping, got ${datasource === null ? 'null' : typeof datasource}`,
    );
  }
  return datasource as Record<string, unknown>;
}

export function parseSettingsConfig(raw: unknown): SettingsConfig {
  const ds = readDatasourceMapping(raw);
  if (!ds) {
    return { pluralizeTableNames: true, useOptimisticConcurrency: false };
  }
  const useOptimisticConcurrency = readOptionalBoolean(
    ds,
    'use_optimistic_concurrency',
    false,
  );
  const flag = ds.pluralize_datatable_names;
  if (flag === undefined) {
    return { pluralizeTableNames: true, useOptimisticConcurrency };
  }
  if (typeof flag !== 'boolean') {
    throw new Error(
      `settings.yaml: 'settings.datasource.pluralize_datatable_names' must be a boolean, got ${typeof flag} (${JSON.stringify(flag)})`,
    );
  }
  return { pluralizeTableNames: flag, useOptimisticConcurrency };
}

export async function loadSettingsConfig(yamlPath: string): Promise<SettingsConfig> {
  if (!(await pathExists(yamlPath))) {
    throw new Error(`settings.yaml not found at ${yamlPath}`);
  }
  return parseSettingsConfig(yaml.load(await readFile(yamlPath, 'utf8')));
}
