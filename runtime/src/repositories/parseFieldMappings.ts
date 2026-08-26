export type EntityFieldMap = ReadonlyMap<string, string>;
export type FieldMappings = ReadonlyMap<string, EntityFieldMap>;

export interface DatasourceMappings {
  renames: FieldMappings;
  converters: FieldMappings;
}

const EMPTY_MAPPINGS: DatasourceMappings = {
  renames: new Map(),
  converters: new Map(),
};

function mergeInto(
  target: Map<string, Map<string, string>>,
  entityName: string,
  entries: Map<string, string>,
): void {
  if (entries.size === 0) return;
  const existing = target.get(entityName);
  if (existing) {
    for (const [k, v] of entries) existing.set(k, v);
  } else {
    target.set(entityName, entries);
  }
}

interface ParsedRow {
  logicalCol: string;
  source?: string;
  typeConverter?: string;
}

function parseRow(fm: unknown, prefix: string, j: number): ParsedRow {
  if (!fm || typeof fm !== 'object') {
    throw new Error(
      `parseFieldMappings: ${prefix}.field_mappings[${j}] must be an object, got ${typeof fm}`,
    );
  }
  const colKeys = Object.keys(fm as Record<string, unknown>);
  if (colKeys.length !== 1) {
    throw new Error(
      `parseFieldMappings: ${prefix}.field_mappings[${j}] must wrap exactly one column name, got ${colKeys.length}: ${JSON.stringify(colKeys)}`,
    );
  }
  const logicalCol = colKeys[0];
  const colBody = (fm as Record<string, unknown>)[logicalCol];
  if (!colBody || typeof colBody !== 'object') {
    throw new Error(
      `parseFieldMappings: ${prefix}.field_mappings[${j}].${logicalCol} must be an object, got ${typeof colBody}`,
    );
  }
  const source = (colBody as Record<string, unknown>).source;
  const typeConverter = (colBody as Record<string, unknown>).type_converter;
  const where = `${prefix}.field_mappings[${j}].${logicalCol}`;
  if (source === undefined && typeConverter === undefined) {
    throw new Error(`parseFieldMappings: ${where} must declare 'source' or 'type_converter'`);
  }
  if (source !== undefined && typeof source !== 'string') {
    throw new Error(
      `parseFieldMappings: ${where}.source must be a string, got ${typeof source}: ${JSON.stringify(source)}`,
    );
  }
  if (typeConverter !== undefined && typeof typeConverter !== 'string') {
    throw new Error(
      `parseFieldMappings: ${where}.type_converter must be a string, got ${typeof typeConverter}: ${JSON.stringify(typeConverter)}`,
    );
  }
  return {
    logicalCol,
    source: source as string | undefined,
    typeConverter: typeConverter as string | undefined,
  };
}

interface ParsedEntity {
  entityName: string;
  renameMap: Map<string, string>;
  converterMap: Map<string, string>;
}

function collectRows(
  rawFieldMappings: unknown[],
  prefix: string,
): { renameMap: Map<string, string>; converterMap: Map<string, string> } {
  const seen = new Set<string>();
  const renameMap = new Map<string, string>();
  const converterMap = new Map<string, string>();
  for (let j = 0; j < rawFieldMappings.length; j++) {
    const { logicalCol, source, typeConverter } = parseRow(rawFieldMappings[j], prefix, j);
    if (seen.has(logicalCol)) {
      throw new Error(
        `parseFieldMappings: ${prefix} declares column '${logicalCol}' twice in field_mappings`,
      );
    }
    seen.add(logicalCol);
    if (source !== undefined) renameMap.set(logicalCol, source);
    if (typeConverter !== undefined) converterMap.set(logicalCol, typeConverter);
  }
  return { renameMap, converterMap };
}

function parseEntity(entry: unknown, i: number): ParsedEntity | null {
  if (!entry || typeof entry !== 'object') {
    throw new Error(
      `parseFieldMappings: datasource_mappings[${i}] must be an object, got ${typeof entry}`,
    );
  }
  const entityKeys = Object.keys(entry as Record<string, unknown>);
  if (entityKeys.length !== 1) {
    throw new Error(
      `parseFieldMappings: datasource_mappings[${i}] must wrap exactly one entity name, got ${entityKeys.length} keys: ${JSON.stringify(entityKeys)}`,
    );
  }
  const entityName = entityKeys[0];
  const entityBody = (entry as Record<string, unknown>)[entityName];
  if (!entityBody || typeof entityBody !== 'object') {
    throw new Error(
      `parseFieldMappings: datasource_mappings[${i}].${entityName} must be an object, got ${typeof entityBody}`,
    );
  }
  const rawFieldMappings = (entityBody as Record<string, unknown>).field_mappings;
  if (rawFieldMappings === undefined || rawFieldMappings === null) return null;
  if (!Array.isArray(rawFieldMappings)) {
    throw new Error(
      `parseFieldMappings: datasource_mappings[${i}].${entityName}.field_mappings must be an array, got ${typeof rawFieldMappings}`,
    );
  }
  const prefix = `datasource_mappings[${i}].${entityName}`;
  const { renameMap, converterMap } = collectRows(rawFieldMappings, prefix);
  return { entityName, renameMap, converterMap };
}

export function parseAllMappings(datasourceData: unknown): DatasourceMappings {
  if (datasourceData === null || datasourceData === undefined) {
    return EMPTY_MAPPINGS;
  }
  if (typeof datasourceData !== 'object') {
    throw new Error(`parseFieldMappings: expected an object, got ${typeof datasourceData}`);
  }
  const renames = new Map<string, Map<string, string>>();
  const converters = new Map<string, Map<string, string>>();
  parseLegacyDatasourceMappings(datasourceData, renames, converters);
  parseTypesFieldMappings(datasourceData, renames);
  return { renames: renames as FieldMappings, converters: converters as FieldMappings };
}

function parseLegacyDatasourceMappings(
  datasourceData: unknown,
  renames: Map<string, Map<string, string>>,
  converters: Map<string, Map<string, string>>,
): void {
  const rawMappings = (datasourceData as Record<string, unknown>).datasource_mappings;
  if (rawMappings === undefined || rawMappings === null) return;
  if (!Array.isArray(rawMappings)) {
    throw new Error(
      `parseFieldMappings: datasource_mappings must be an array, got ${typeof rawMappings}`,
    );
  }
  for (let i = 0; i < rawMappings.length; i++) {
    const parsed = parseEntity(rawMappings[i], i);
    if (!parsed) continue;
    mergeInto(renames, parsed.entityName, parsed.renameMap);
    mergeInto(converters, parsed.entityName, parsed.converterMap);
  }
}

/** New `types: [{ entity: { fields: [{ col: { mapping: "…" } }] } }]` overlays. */
function parseTypesFieldMappings(
  datasourceData: unknown,
  renames: Map<string, Map<string, string>>,
): void {
  const types = (datasourceData as Record<string, unknown>).types;
  if (!Array.isArray(types)) return;
  for (const entry of types) {
    if (!entry || typeof entry !== 'object') continue;
    const entityKeys = Object.keys(entry as Record<string, unknown>);
    if (entityKeys.length !== 1) continue;
    const entityName = entityKeys[0]!;
    const body = (entry as Record<string, unknown>)[entityName];
    if (!body || typeof body !== 'object') continue;
    const fields = (body as Record<string, unknown>).fields;
    if (!Array.isArray(fields)) continue;
    const renameMap = new Map<string, string>();
    for (const fieldEntry of fields) {
      if (!fieldEntry || typeof fieldEntry !== 'object') continue;
      const fieldKeys = Object.keys(fieldEntry as Record<string, unknown>);
      if (fieldKeys.length !== 1) continue;
      const logicalCol = fieldKeys[0]!;
      const fieldBody = (fieldEntry as Record<string, unknown>)[logicalCol];
      if (!fieldBody || typeof fieldBody !== 'object') continue;
      const mapping = (fieldBody as Record<string, unknown>).mapping;
      if (typeof mapping === 'string' && mapping.length > 0) {
        renameMap.set(logicalCol, mapping);
      }
    }
    mergeInto(renames, entityName, renameMap);
  }
}

export function parseFieldMappings(datasourceData: unknown): FieldMappings {
  return parseAllMappings(datasourceData).renames;
}

export function getEntityFieldMap(mappings: FieldMappings, entityName: string): EntityFieldMap {
  return mappings.get(entityName) ?? new Map<string, string>();
}
