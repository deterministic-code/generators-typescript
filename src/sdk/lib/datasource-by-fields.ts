/** A field carries its own is_unique marker; a single-column unique index marks its one column as a lookup key. Both live in datasource_types.yaml, so by-field lookups derive from the datasource alone — no routes. */

interface FieldDef {
  is_unique?: boolean;
  type?: string;
  size?: number;
}

interface IndexDef {
  is_unique?: boolean;
  fields?: string[];
}

interface EntityDef {
  fields?: Array<Record<string, FieldDef>>;
  indexes?: Array<Record<string, IndexDef>>;
}

interface DatasourceData {
  types?: Array<Record<string, EntityDef>>;
}

interface FieldShape {
  type: string | undefined;
  size: number | undefined;
}

function isUniqueField(fieldEntry: Record<string, FieldDef>): boolean {
  const def = Object.values(fieldEntry)[0];
  return def != null && typeof def === "object" && def.is_unique === true;
}

function singleColumnUniqueIndexField(
  indexEntry: Record<string, IndexDef>,
): string | null {
  const def = Object.values(indexEntry)[0];
  if (def == null || typeof def !== "object" || def.is_unique !== true) {
    return null;
  }
  return Array.isArray(def.fields) && def.fields.length === 1
    ? def.fields[0]
    : null;
}

function byFieldsForEntity(def: EntityDef): string[] {
  const byFields: string[] = [];
  const add = (name: string | null) => {
    if (typeof name === "string" && name && !byFields.includes(name)) {
      byFields.push(name);
    }
  };
  for (const fieldEntry of Array.isArray(def.fields) ? def.fields : []) {
    if (isUniqueField(fieldEntry)) add(Object.keys(fieldEntry)[0]);
  }
  for (const indexEntry of Array.isArray(def.indexes) ? def.indexes : []) {
    add(singleColumnUniqueIndexField(indexEntry));
  }
  return byFields;
}

/**
 * `Map<entity, byField[]>` of the fields that get `find_<entity>_by_<field>` /
 * `update_<entity>_by_<field>` stored procedures, derived purely from
 * datasource_types.yaml: every `is_unique` field plus every single-column
 * unique index. Keyed by the entity's canonical singular YAML name, matching
 * the table's `entityName`. Entities with no lookup keys are omitted.
 */
export function byFieldsFromDatasource(
  datasourceData: DatasourceData | null | undefined,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const entry of datasourceData?.types ?? []) {
    const [entity, def] = Object.entries(entry)[0];
    const byFields = byFieldsForEntity(def);
    if (byFields.length > 0) map.set(entity, byFields);
  }
  return map;
}

function fieldShapeInEntity(def: EntityDef, fieldName: string): FieldShape {
  for (const fieldEntry of Array.isArray(def.fields) ? def.fields : []) {
    const [name, fdef] = Object.entries(fieldEntry)[0];
    if (name === fieldName) return { type: fdef.type, size: fdef.size };
  }
  return { type: undefined, size: undefined };
}

/**
 * Like `byFieldsFromDatasource`, but each entry carries the column's declared
 * `{ field, type, size }` so a service generator can render a typed
 * `findBy<Field>` finder (param type via the shared type-mapper). Same
 * datasource-only derivation and keying as `byFieldsFromDatasource`.
 */
export function byFieldsWithTypesFromDatasource(
  datasourceData: DatasourceData | null | undefined,
): Map<string, Array<{ field: string } & FieldShape>> {
  const map = new Map<string, Array<{ field: string } & FieldShape>>();
  for (const entry of datasourceData?.types ?? []) {
    const [entity, def] = Object.entries(entry)[0];
    const byFields = byFieldsForEntity(def).map((field) => ({
      field,
      ...fieldShapeInEntity(def, field),
    }));
    if (byFields.length > 0) map.set(entity, byFields);
  }
  return map;
}
