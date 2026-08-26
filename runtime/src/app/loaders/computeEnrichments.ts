export interface RuntimeEnrichment {
  fkColumn: string;
  newField: string;
  targetTable: string;
}

type RawField = {
  type?: string;
  references?: string;
  is_unique?: boolean;
  is_nullable?: boolean;
};
type RawType = {
  datasource_type?: string;
  fields?: Array<Record<string, RawField>>;
};
type DatasourceDoc = { types?: Array<Record<string, RawType>> };

interface TargetMeta {
  datasource_type: string | null;
  fields: Map<string, RawField>;
}

function buildDatasourceMap(doc: DatasourceDoc | null | undefined): Map<string, TargetMeta> {
  const map = new Map<string, TargetMeta>();
  for (const entry of doc?.types ?? []) {
    const [name, def] = Object.entries(entry)[0];
    const fieldMap = new Map<string, RawField>();
    for (const fe of def.fields ?? []) {
      const [fname, fdef] = Object.entries(fe)[0];
      fieldMap.set(fname, fdef);
    }
    map.set(name, { datasource_type: def.datasource_type ?? null, fields: fieldMap });
  }
  return map;
}

function targetIsEnrichable(target: TargetMeta | undefined): boolean {
  if (!target) return false;
  if (target.datasource_type === 'readonly-lookup') return true;
  const nameField = target.fields.get('name');
  if (!nameField) return false;
  if (nameField.type !== 'string') return false;
  if (nameField.is_unique !== true) return false;
  if (nameField.is_nullable === true) return false;
  return true;
}

function parseFkReference(fdef: RawField | undefined): { table: string } | null {
  if (!fdef || typeof fdef !== 'object') return null;
  if (fdef.type !== 'number') return null;
  const ref = fdef.references;
  if (typeof ref !== 'string') return null;
  const dot = ref.indexOf('.');
  if (dot <= 0) return null;
  const table = ref.slice(0, dot);
  const column = ref.slice(dot + 1);
  if (column !== 'id') return null;
  return { table };
}

/** Build enrichments from a parsed CRUD spec (flattened inherit/union + overlay unique). */
export function enrichmentsFromCrudSpec(spec: {
  enrichmentColumns?: string[];
  fields?: ReadonlyArray<{ name: string; references?: string }>;
}): RuntimeEnrichment[] {
  const fields = spec.fields ?? [];
  const out: RuntimeEnrichment[] = [];
  for (const newField of spec.enrichmentColumns ?? []) {
    if (!newField.endsWith('_name')) continue;
    const fkColumn = `${newField.slice(0, -'_name'.length)}_id`;
    const field = fields.find((f) => f.name === fkColumn);
    const ref = field?.references;
    if (typeof ref !== 'string') continue;
    const dot = ref.indexOf('.');
    if (dot <= 0) continue;
    out.push({ fkColumn, newField, targetTable: ref.slice(0, dot) });
  }
  return out;
}

export function computeEnrichments(
  entityTable: string,
  datasourceDoc: DatasourceDoc | null | undefined,
): RuntimeEnrichment[] {
  const dsMap = buildDatasourceMap(datasourceDoc);
  const entity = dsMap.get(entityTable);
  if (!entity) return [];
  const out: RuntimeEnrichment[] = [];
  for (const [colName, fdef] of entity.fields) {
    if (!colName.endsWith('_id')) continue;
    const ref = parseFkReference(fdef);
    if (!ref) continue;
    const target = dsMap.get(ref.table);
    if (!targetIsEnrichable(target)) continue;
    const prefix = colName.slice(0, -'_id'.length);
    out.push({ fkColumn: colName, newField: `${prefix}_name`, targetTable: ref.table });
  }
  return out;
}
