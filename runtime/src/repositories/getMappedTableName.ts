import { effectiveTableName } from './effectiveTableName';

export function getMappedTableName(
  spec: unknown,
  entityName: string,
  pluralizeTableNames = false,
): string {
  const explicit = readExplicitMapping(spec, entityName);
  if (explicit !== null) return explicit;
  return effectiveTableName(entityName, pluralizeTableNames);
}

function readExplicitMapping(spec: unknown, entityName: string): string | null {
  if (!spec || typeof spec !== 'object') return null;
  const fromLegacy = readLegacyDatasourceMapping(spec, entityName);
  if (fromLegacy !== null) return fromLegacy;
  return readTypesMapping(spec, entityName);
}

/** Old `datasource_mappings: [{ entity: { source: "…" } }]` shape. */
function readLegacyDatasourceMapping(spec: unknown, entityName: string): string | null {
  const mappings = (spec as Record<string, unknown>).datasource_mappings;
  if (!Array.isArray(mappings) || mappings.length === 0) return null;
  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== 'object') continue;
    const entry = (mapping as Record<string, unknown>)[entityName];
    if (entry && typeof entry === 'object' && 'source' in entry) {
      const source = (entry as Record<string, unknown>).source;
      if (typeof source === 'string') return source;
    }
  }
  return null;
}

/** New `types: [{ entity: { mapping: "…" } }]` shape (datasource.yaml overlays). */
function readTypesMapping(spec: unknown, entityName: string): string | null {
  const types = (spec as Record<string, unknown>).types;
  if (!Array.isArray(types)) return null;
  for (const entry of types) {
    if (!entry || typeof entry !== 'object') continue;
    const body = (entry as Record<string, unknown>)[entityName];
    if (!body || typeof body !== 'object') continue;
    const mapping = (body as Record<string, unknown>).mapping;
    if (typeof mapping === 'string' && mapping.length > 0) return mapping;
  }
  return null;
}
