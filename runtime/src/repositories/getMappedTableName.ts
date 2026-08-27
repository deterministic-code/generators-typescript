import { effectiveTableName } from './effectiveTableName';

const BUILTIN_INHERITS = new Set(['set', 'dictionary', 'file']);

export function getMappedTableName(
  spec: unknown,
  entityName: string,
  pluralizeTableNames = false,
  typesDoc?: unknown,
): string {
  const seen = new Set<string>();
  let current: string | undefined = entityName;
  while (current !== undefined && !seen.has(current) && !BUILTIN_INHERITS.has(current)) {
    seen.add(current);
    const explicit = readExplicitMapping(spec, current);
    if (explicit !== null) return explicit;
    current = inheritOf(typesDoc, current) ?? inheritOf(spec, current);
  }
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

export function inheritOf(doc: unknown, entityName: string): string | undefined {
  if (!doc || typeof doc !== 'object') return undefined;
  const types = (doc as Record<string, unknown>).types;
  if (!Array.isArray(types)) return undefined;
  for (const entry of types) {
    if (!entry || typeof entry !== 'object') continue;
    const body = (entry as Record<string, unknown>)[entityName];
    if (!body || typeof body !== 'object') continue;
    const inherits = (body as Record<string, unknown>).inherits;
    return typeof inherits === 'string' && inherits.length > 0 ? inherits : undefined;
  }
  return undefined;
}
