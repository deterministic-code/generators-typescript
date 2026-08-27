import type { IDatasourceNaming } from '@deterministic-code/generators-common/datasource-naming';
import type { DatasourceData, DatasourceTypeDef } from '../routes/iterateCombinedRoutes';

const BUILTIN_INHERITS = new Set(['set', 'dictionary', 'file']);

const indexTypeDoc = (doc: DatasourceData): Map<string, DatasourceTypeDef> => {
  const out = new Map<string, DatasourceTypeDef>();
  for (const entry of doc.types ?? []) {
    for (const [name, body] of Object.entries(entry)) {
      out.set(name, body);
    }
  }
  for (const row of doc.datasource_mappings ?? []) {
    for (const [name, body] of Object.entries(row)) {
      if (body.source === undefined) continue;
      const prev = out.get(name) ?? {};
      out.set(name, { ...prev, mapping: prev.mapping ?? body.source });
    }
  }
  return out;
};

const typeIndex = (
  overlays: DatasourceData,
  types: DatasourceData = {},
): Map<string, DatasourceTypeDef> => {
  const out = indexTypeDoc(types);
  for (const [name, row] of indexTypeDoc(overlays)) {
    const prev = out.get(name);
    out.set(name, {
      inherits: row.inherits ?? prev?.inherits,
      mapping: row.mapping ?? prev?.mapping,
    });
  }
  return out;
};

export const getMappedTableName = (
  overlays: DatasourceData,
  entityName: string,
  naming: IDatasourceNaming,
  types?: DatasourceData,
): string => {
  const index = typeIndex(overlays, types);
  const seen = new Set<string>();
  for (let name: string | undefined = entityName; name && !seen.has(name) && !BUILTIN_INHERITS.has(name); ) {
    seen.add(name);
    const mapping = index.get(name)?.mapping;
    if (mapping !== undefined) return naming.resolveTable(entityName, mapping);
    name = index.get(name)?.inherits;
  }
  return naming.resolveTable(entityName);
};
