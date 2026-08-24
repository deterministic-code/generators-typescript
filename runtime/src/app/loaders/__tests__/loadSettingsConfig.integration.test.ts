import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSettingsConfig, loadSettingsConfig } from '../loadSettingsConfig';

describe('parseSettingsConfig — defaults', () => {
  it('returns defaults when input is null', () => {
    expect(parseSettingsConfig(null)).toEqual({
      pluralizeTableNames: true,
      useOptimisticConcurrency: false,
    });
  });

  it('returns defaults when input is undefined', () => {
    expect(parseSettingsConfig(undefined)).toEqual({
      pluralizeTableNames: true,
      useOptimisticConcurrency: false,
    });
  });

  it('returns defaults when the file has no settings block', () => {
    expect(parseSettingsConfig({})).toEqual({
      pluralizeTableNames: true,
      useOptimisticConcurrency: false,
    });
  });

  it('returns defaults when settings has no datasource block', () => {
    expect(parseSettingsConfig({ settings: {} })).toEqual({
      pluralizeTableNames: true,
      useOptimisticConcurrency: false,
    });
  });

  it('returns defaults when datasource is empty', () => {
    expect(parseSettingsConfig({ settings: { datasource: {} } })).toEqual({
      pluralizeTableNames: true,
      useOptimisticConcurrency: false,
    });
  });
});

describe('parseSettingsConfig — explicit values', () => {
  it('returns pluralizeTableNames: true when the flag is explicitly true', () => {
    expect(
      parseSettingsConfig({
        settings: { datasource: { pluralize_datatable_names: true } },
      }),
    ).toEqual({
      pluralizeTableNames: true,
      useOptimisticConcurrency: false,
    });
  });

  it('returns pluralizeTableNames: false when the flag is explicitly false', () => {
    expect(
      parseSettingsConfig({
        settings: { datasource: { pluralize_datatable_names: false } },
      }),
    ).toEqual({
      pluralizeTableNames: false,
      useOptimisticConcurrency: false,
    });
  });

  it('defaults useOptimisticConcurrency to false when the flag is omitted', () => {
    expect(
      parseSettingsConfig({ settings: { datasource: {} } }).useOptimisticConcurrency,
    ).toBe(false);
  });

  it('reads use_optimistic_concurrency: true from the datasource block', () => {
    expect(
      parseSettingsConfig({
        settings: { datasource: { use_optimistic_concurrency: true } },
      }).useOptimisticConcurrency,
    ).toBe(true);
  });

  it('throws when use_optimistic_concurrency is not a boolean', () => {
    expect(() =>
      parseSettingsConfig({
        settings: { datasource: { use_optimistic_concurrency: 'true' } },
      }),
    ).toThrow(/'settings.datasource.use_optimistic_concurrency' must be a boolean/);
  });
});

describe('parseSettingsConfig — strict validation (GATE 16)', () => {
  it('throws when top level is a primitive', () => {
    expect(() => parseSettingsConfig('not-an-object' as never)).toThrow(
      /expected top-level mapping/,
    );
  });

  it('throws when settings is a null', () => {
    expect(() => parseSettingsConfig({ settings: null })).toThrow(/'settings' to be a mapping/);
  });

  it('throws when settings is a primitive', () => {
    expect(() => parseSettingsConfig({ settings: 'oops' as never })).toThrow(
      /'settings' to be a mapping/,
    );
  });

  it('throws when datasource is null', () => {
    expect(() => parseSettingsConfig({ settings: { datasource: null } })).toThrow(
      /'settings.datasource' to be a mapping/,
    );
  });

  it('throws when datasource is a primitive', () => {
    expect(() => parseSettingsConfig({ settings: { datasource: 'oops' as never } })).toThrow(
      /'settings.datasource' to be a mapping/,
    );
  });

  it('throws when pluralize_datatable_names is a string (typo)', () => {
    expect(() =>
      parseSettingsConfig({
        settings: { datasource: { pluralize_datatable_names: 'false' } },
      }),
    ).toThrow(/'settings.datasource.pluralize_datatable_names' must be a boolean/);
  });

  it('throws when pluralize_datatable_names is a number', () => {
    expect(() =>
      parseSettingsConfig({
        settings: { datasource: { pluralize_datatable_names: 0 } },
      }),
    ).toThrow(/must be a boolean/);
  });

  it('throws when pluralize_datatable_names is null', () => {
    expect(() =>
      parseSettingsConfig({
        settings: { datasource: { pluralize_datatable_names: null } },
      }),
    ).toThrow(/must be a boolean/);
  });
});

describe('loadSettingsConfig — file I/O', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-config-'));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('throws when the file does not exist', async () => {
    await expect(loadSettingsConfig(path.join(dir, 'absent.yaml'))).rejects.toThrow(
      /settings\.yaml not found/,
    );
  });

  it('reads pluralize_datatable_names: false from a real YAML file', async () => {
    const yamlPath = path.join(dir, 'settings-false.yaml');
    await fs.writeFile(
      yamlPath,
      'settings:\n  datasource:\n    pluralize_datatable_names: false\n',
    );
    const cfg = await loadSettingsConfig(yamlPath);
    expect(cfg).toEqual({
      pluralizeTableNames: false,
      useOptimisticConcurrency: false,
    });
  });

  it('reads pluralize_datatable_names: true from a real YAML file', async () => {
    const yamlPath = path.join(dir, 'settings-true.yaml');
    await fs.writeFile(
      yamlPath,
      'settings:\n  datasource:\n    pluralize_datatable_names: true\n',
    );
    const cfg = await loadSettingsConfig(yamlPath);
    expect(cfg).toEqual({
      pluralizeTableNames: true,
      useOptimisticConcurrency: false,
    });
  });

  it('returns defaults when the YAML has no datasource block', async () => {
    const yamlPath = path.join(dir, 'settings-empty.yaml');
    await fs.writeFile(yamlPath, 'other: stuff\n');
    expect(await loadSettingsConfig(yamlPath)).toEqual({
      pluralizeTableNames: true,
      useOptimisticConcurrency: false,
    });
  });
});
