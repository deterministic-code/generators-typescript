import { z } from 'zod';

import { kebabPlural, singularizeToken } from '../../naming/index';
import { routeViewTypeDirective } from './routeViewTypeDirective';
import { parseRelationType, relationIsArray } from './computeEagerChildren';
import type { StandardIdType } from '../../repositories/standardFieldConverting';

export interface EagerWriteChildSpec {
  /** Discriminator. Defaults to 'direct-fk' when absent (backward-compat). */
  kind?: 'direct-fk' | 'm2m';
  fieldName: string;
  /** For direct-fk: the child table. For m2m: the M2M target table. */
  childTable: string;
  /** Direct-fk only: FK column on child table that points to the parent. */
  fkColumn?: string;
  /** M2M only: the junction table linking parent and target. */
  junctionTable?: string;
  /** M2M only: junction column referencing the parent (e.g. post_id). */
  parentFkColumn?: string;
  /** M2M only: junction column referencing the target (e.g. tag_id). */
  targetFkColumn?: string;
  childColumns: string[];
  childColumnTypes?: Record<string, CrudFieldType>;
  // `_name` cols the child's LookupEnrichedService resolves to `_id` before insert; strict child schema must accept them.
  childEnrichmentColumns?: string[];
  /** Nested eager-write children of this child. Populated for depth-N paths. */
  children?: EagerWriteChildSpec[];
  /** False when the view field is a single nested object. Omitted/`true` is a collection. */
  isArray?: boolean;
}

interface ByFieldRouteSpec {
  /** Column on this entity used as the lookup key, e.g. "key" or "notification_type". */
  field: string;
  /** True when the column is unique (1:1 lookup). False emits collection semantics. */
  unique: boolean;
  /** HTTP verbs to mount. Defaults to all of GET/PUT/DELETE when omitted upstream. */
  methods: Array<'GET' | 'PUT' | 'DELETE'>;
}

type CrudFieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'smallinteger'
  | 'biginteger'
  | 'float'
  | 'boolean'
  | 'datetime'
  | 'uuid'
  | 'binary'
  | 'reference';

interface CrudFieldDef {
  name: string;
  type: CrudFieldType;
  size?: number | 'unlimited';
  min_size?: number;
  is_nullable?: boolean;
  references?: string;
  default_value?: unknown;
  has_default_value?: boolean;
}

export interface CrudRouteSpec {
  pathSegment: string;
  entityName: string;
  columns: string[];
  columnTypes?: Record<string, CrudFieldType>;
  enrichmentColumns?: string[];
  fields?: CrudFieldDef[];
  /** View types expose lookup names and hide the FK on the wire (legacy auto_enrich). */
  replaceLookupFks?: boolean;
  readonly?: boolean;
  m2m?: boolean;
  nestedOnly?: boolean;
  eagerWriteChildren?: EagerWriteChildSpec[];
  byFields?: ByFieldRouteSpec[];
  /**
   * Name of the primary-key column on the underlying table. Set when the
   * YAML declares `primary_key: true` or datasource overlay `is_fixed_id: true`
   * on a non-id field (e.g. `legacy_contact.key`), else the implicit
   * auto-increment `id`. Always resolved by `assignPrimaryKey` so
   * createBackendApp forwards a concrete column to `buildRepoForBackend`
   * and `new EntityService(...)` with no `?? 'id'` default.
   */
  primaryKeyColumn: string;
  /**
   * The primary-key id shape, resolved for every entity: a declared custom PK's
   * own type, else the project id_type from settings. Never a literal default.
   */
  primaryKeyIdType: StandardIdType;
  /** Full identity when the entity authors `ids: [...]` or multiple `is_id` fields. */
  primaryKeyColumns?: Array<{ column: string; idType: StandardIdType }>;
}

type RawField = {
  type?: string;
  references?: string;
  is_unique?: boolean;
  is_nullable?: boolean;
  is_id?: boolean;
  is_fixed_id?: boolean;
  primary_key?: boolean;
  size?: number | 'unlimited';
  min_size?: number;
  default_value?: unknown;
};
type RawType = {
  datasource_type?: string;
  ids?: string[];
  inherits?: string;
  union?: string[];
  mapping?: Record<string, string>;
  remove_fields?: string[];
  tags?: string[];
  fields?: Array<Record<string, RawField>>;
};
type DatasourceDoc = { types?: Array<Record<string, RawType>> };
type CombinedChildOpts = { via?: string; target?: string; route?: string };
type CombinedParent = { combined_types?: Array<string | Record<string, CombinedChildOpts>> };
type CombinedRoutesDoc = { combined_routes?: Array<Record<string, CombinedParent>> };
type ViewTypeField = { type?: string; references?: string };
type RawViewType = { inherits?: string; fields?: Array<Record<string, ViewTypeField>> };
type ViewTypesDoc = { types?: Array<Record<string, RawViewType>> };

export function serviceKeyFor(entityName: string): string {
  const parts = entityName.split('_');
  const camel = parts
    .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('');
  return `${camel}Service`;
}

const STAMP_COLUMNS = new Set(['id', 'uuid', 'created', 'updated', 'version']);

const isCollectionType = (type: string | undefined): boolean =>
  typeof type === 'string' && (type.endsWith('[]') || type.includes('['));

export function buildBodySchema(
  spec: CrudRouteSpec,
  verb: 'create' | 'update' | 'patch' = 'update',
): z.ZodObject<z.ZodRawShape> {
  const enrichmentCols = new Set(spec.enrichmentColumns ?? []);
  const bodyColumns = spec.columns.filter((col) => {
    if (col === spec.primaryKeyColumn) return verb !== 'create';
    return verb !== 'create' || !STAMP_COLUMNS.has(col);
  });
  const allCols = new Set([...bodyColumns, ...enrichmentCols]);

  const shape =
    spec.fields && spec.fields.length > 0
      ? buildStrictTopShape(Array.from(allCols), spec.fields, enrichmentCols)
      : buildColumnShape(Array.from(allCols), spec.columnTypes);

  if (!spec.eagerWriteChildren || spec.eagerWriteChildren.length === 0) {
    return z.object(shape).strict();
  }

  for (const child of spec.eagerWriteChildren) {
    shape[child.fieldName] = wrapEagerChildSchema(buildChildRowSchema(child, verb), child);
  }

  return z.object(shape).strict();
}

// TODO(GATE 17): tighten eager-write child schemas in a follow-up — keeping loose for PR1 scope
function buildChildRowSchema(
  child: EagerWriteChildSpec,
  verb: 'create' | 'update' | 'patch',
): z.ZodObject<z.ZodRawShape> {
  const childShape = buildColumnShape(child.childColumns, child.childColumnTypes);

  // For M2M children at create, callers may pass `{ id }` to link an existing target (see EagerChildWritingService.m2mLink); other verbs / direct-fk allow id only on update/patch.
  const allowsId = verb !== 'create' || child.kind === 'm2m';
  const baseShape: z.ZodRawShape = allowsId
    ? { id: z.number().optional(), ...childShape }
    : childShape;

  // why: LookupEnrichedService.create on the child resolves `_name`→`_id`; strict child schema must accept the `_name` keys.
  if (child.childEnrichmentColumns) {
    for (const name of child.childEnrichmentColumns) {
      baseShape[name] = z.string().optional().nullable();
    }
  }

  if (child.children && child.children.length > 0) {
    for (const grand of child.children) {
      baseShape[grand.fieldName] = wrapEagerChildSchema(
        buildChildRowSchema(grand, verb),
        grand,
      );
    }
  }

  return z.object(baseShape).strict();
}

function wrapEagerChildSchema(
  rowSchema: z.ZodObject<z.ZodRawShape>,
  child: { isArray?: boolean },
): z.ZodTypeAny {
  return relationIsArray(child)
    ? z.array(rowSchema).optional()
    : rowSchema.nullable().optional();
}

function depluraliseSnake(name: string): string {
  const snake = name.replace(/-/g, '_');
  return snake.endsWith('s') ? snake.slice(0, -1) : snake;
}

function buildColumnShape(
  columns: string[],
  columnTypes?: Record<string, CrudFieldType>,
): z.ZodRawShape {
  const shape: z.ZodRawShape = {};
  const types = columnTypes ?? {};

  for (const col of columns) {
    const type = types[col];
    if (type === 'boolean') {
      shape[col] = z.boolean().optional().nullable();
    } else if (type === 'number') {
      shape[col] = z.number().int().optional().nullable();
    } else {
      shape[col] = z.union([z.string(), z.number()]).optional().nullable();
    }
  }

  return shape;
}

function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);
}

function baseZodForField(type: CrudFieldType): z.ZodTypeAny {
  switch (type) {
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
    case 'smallinteger':
    case 'float':
    case 'reference':
      return z.number();
    case 'biginteger':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'datetime':
      return z.string();
    case 'binary':
      return z.string().base64();
    case 'uuid':
      return z.string().uuid();
  }
}

function tightenNumber(base: z.ZodTypeAny, fdef: CrudFieldDef): z.ZodNumber {
  let n = (base as z.ZodNumber).int();
  const isFk = typeof fdef.references === 'string' && fdef.references.length > 0;
  const isIdLike = fdef.name === 'id' || fdef.name.endsWith('_id');
  if (isFk || isIdLike) n = n.nonnegative();
  if (isFiniteInt(fdef.min_size)) n = n.min(fdef.min_size);
  if (isFiniteInt(fdef.size)) n = n.max(fdef.size);
  return n;
}

function tightenedZodFor(fdef: CrudFieldDef): z.ZodTypeAny {
  const base = baseZodForField(fdef.type);
  switch (fdef.type) {
    case 'string': {
      let s = (base as z.ZodString).trim();
      if (isFiniteInt(fdef.min_size) && fdef.min_size >= 0) s = s.min(fdef.min_size);
      if (isFiniteInt(fdef.size) && fdef.size >= 0) s = s.max(fdef.size);
      return s;
    }
    case 'datetime':
      // Wire datetime arrives as an ISO string (JSON has no Date); coerce it to a Date here so the datasource's write converter — which requires a Date — receives one instead of throwing. An unparseable string surfaces as a 400, not a 500 at the converter.
      return (base as z.ZodString)
        .trim()
        .transform((value) => new Date(value))
        .refine((parsed) => !Number.isNaN(parsed.getTime()), {
          message: 'Expected an ISO-8601 datetime string',
        });
    case 'number':
    case 'integer':
    case 'biginteger':
    case 'smallinteger':
    case 'reference':
      return tightenNumber(base, fdef);
    case 'float': {
      let n = base as z.ZodNumber;
      if (isFiniteInt(fdef.min_size)) n = n.min(fdef.min_size);
      return n;
    }
    default:
      return base;
  }
}

function applyNullableAndDefault(expr: z.ZodTypeAny, fdef: CrudFieldDef): z.ZodTypeAny {
  let out = expr;
  if (fdef.is_nullable === true) out = out.nullable().optional();
  if (fdef.has_default_value === true) out = out.default(fdef.default_value as never);
  return out;
}

function buildStrictTopShape(
  columns: string[],
  fields: CrudFieldDef[],
  enrichmentColumns: Set<string>,
): z.ZodRawShape {
  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  // why-optional: when FK column has matching <prefix>_name in enrichmentColumns, LookupEnrichedService.resolveInboundNames maps name->id before repo; OpenAPI body sample carries _name only so requiring _id 400s "<fk>: Required" on a valid body.
  const enricherResolvableFks = new Set<string>();
  for (const f of fields) {
    if (!f.name.endsWith('_id')) continue;
    const prefix = f.name.slice(0, -'_id'.length);
    if (enrichmentColumns.has(`${prefix}_name`)) enricherResolvableFks.add(f.name);
  }
  const shape: z.ZodRawShape = {};
  for (const col of columns) {
    const fdef = fieldByName.get(col);
    if (!fdef) {
      shape[col] = z.union([z.string(), z.number()]).optional().nullable();
      continue;
    }
    let expr = applyNullableAndDefault(tightenedZodFor(fdef), fdef);
    if (enricherResolvableFks.has(fdef.name)) expr = expr.optional();
    shape[col] = expr;
  }
  return shape;
}

function targetIsEnrichable(datasourceMap: Map<string, RawType>, table: string): boolean {
  const target = datasourceMap.get(table);
  if (!target) return false;
  if (target.datasource_type === 'readonly-lookup') return true;
  const fields = target.fields ?? [];
  const nameField = fields.find((f) => Object.keys(f)[0] === 'name');
  if (!nameField) return false;
  const [, nameDef] = Object.entries(nameField)[0];
  if (nameDef.type !== 'string') return false;
  if (nameDef.is_unique !== true) return false;
  if (nameDef.is_nullable === true) return false;
  return true;
}

function enrichmentColumnsFromMap(
  entityName: string,
  datasourceMap: Map<string, RawType>,
): string[] {
  const entity = datasourceMap.get(entityName);
  if (!entity) return [];

  const enrichmentColumns: string[] = [];
  const fields = entity.fields ?? [];
  for (const fieldEntry of fields) {
    const [colName, fdef] = Object.entries(fieldEntry)[0];
    if (!colName.endsWith('_id')) continue;
    if (fdef.type !== 'number') continue;
    if (typeof fdef.references !== 'string') continue;
    const dot = fdef.references.indexOf('.');
    if (dot <= 0) continue;
    const refTable = fdef.references.slice(0, dot);
    const refColumn = fdef.references.slice(dot + 1);
    if (refColumn !== 'id') continue;
    if (!targetIsEnrichable(datasourceMap, refTable)) continue;
    const prefix = colName.slice(0, -'_id'.length);
    enrichmentColumns.push(`${prefix}_name`);
  }
  return enrichmentColumns;
}

function enrichmentColumnsFromFields(
  fields: Array<[string, RawField]>,
  ctx: CrudSpecContext,
): string[] {
  const enrichmentColumns: string[] = [];
  for (const [colName, fdef] of fields) {
    if (!colName.endsWith('_id')) continue;
    if (fdef.type !== 'number' && fdef.type !== 'integer' && fdef.type !== undefined) continue;
    if (typeof fdef.references !== 'string') continue;
    const dot = fdef.references.indexOf('.');
    if (dot <= 0) continue;
    const refTable = fdef.references.slice(0, dot);
    const refColumn = fdef.references.slice(dot + 1);
    if (refColumn !== 'id') continue;
    const targetFields = mergeOverlayFields(
      flattenTypeFields(refTable, ctx.typesByName),
      ctx.overlayFields.get(refTable),
    );
    const nameField = targetFields.find(([name]) => name === 'name')?.[1];
    if (nameField?.type !== 'string' || nameField.is_unique !== true || nameField.is_nullable === true) {
      continue;
    }
    enrichmentColumns.push(`${colName.slice(0, -'_id'.length)}_name`);
  }
  return enrichmentColumns;
}

function readTypes(doc: unknown): Array<[string, RawType]> {
  const parsed = (doc as DatasourceDoc | null) ?? {};
  const out: Array<[string, RawType]> = [];
  for (const entry of parsed.types ?? []) {
    const [name, body] = Object.entries(entry)[0];
    out.push([name, body]);
  }
  return out;
}

function extractFields(body: RawType): Array<[string, RawField]> {
  return (body.fields ?? []).map((entry) => {
    const [name, field] = Object.entries(entry)[0];
    return [name, field] as [string, RawField];
  });
}

const flattenTypeFields = (
  name: string,
  types: Map<string, RawType>,
  walking: Set<string> = new Set(),
): Array<[string, RawField]> => {
  if (walking.has(name)) return [];
  const body = types.get(name);
  if (body === undefined) return [];
  walking.add(name);
  const inherited =
    typeof body.inherits === 'string' && body.inherits.length > 0
      ? flattenTypeFields(body.inherits, types, walking)
      : [];
  const own = extractFields(body);
  const fields = [...inherited, ...own];
  const mapping = body.mapping ?? {};
  const removed = new Set(body.remove_fields ?? []);
  for (const unionName of body.union ?? []) {
    for (const [fieldName, field] of flattenTypeFields(unionName, types, new Set(walking))) {
      if (removed.has(`${unionName}.${fieldName}`) || removed.has(fieldName)) continue;
      fields.push([mapping[fieldName] ?? fieldName, field]);
    }
  }
  walking.delete(name);
  return fields;
};

function collectNestedOnlyEntities(
  routesDoc: unknown,
  types: Array<[string, RawType]>,
): Set<string> {
  const doc = (routesDoc as CombinedRoutesDoc | null) ?? {};
  const fieldsByType = new Map(types.map(([name, body]) => [name, extractFields(body)]));
  const nested = new Set<string>();

  // Entities that appear as combined-route parents get their own top-level CRUD via emitParentCrudRoutes — must stay mountable at top-level even when also FK child of another parent.
  const parentEntities = new Set<string>();
  for (const parentEntry of doc.combined_routes ?? []) {
    for (const parentKey of Object.keys(parentEntry)) {
      parentEntities.add(depluraliseSnake(parentKey));
    }
  }

  const hasDirectFkTo = (childEntity: string, parentEntity: string): boolean => {
    const fields = fieldsByType.get(childEntity) ?? [];
    const expectedRef = `${parentEntity}.id`;
    return fields.some(([, f]) => f.references === expectedRef);
  };

  for (const parentEntry of doc.combined_routes ?? []) {
    for (const [parentKey, parent] of Object.entries(parentEntry)) {
      const parentEntity = depluraliseSnake(parentKey);
      for (const child of parent.combined_types ?? []) {
        if (typeof child === 'string') {
          const childEntity = depluraliseSnake(child);
          if (parentEntities.has(childEntity)) continue;
          if (hasDirectFkTo(childEntity, parentEntity)) nested.add(childEntity);
          continue;
        }
        const [childName, opts] = Object.entries(child)[0];
        if (opts && (opts.via || opts.target)) continue;
        const childEntity = depluraliseSnake(childName);
        if (parentEntities.has(childEntity)) continue;
        if (hasDirectFkTo(childEntity, parentEntity)) nested.add(childEntity);
      }
    }
  }
  return nested;
}

function inferredFieldType(field: RawField): CrudFieldType | undefined {
  if (field.type && CRUD_FIELD_TYPES.has(field.type as CrudFieldType)) {
    return field.type as CrudFieldType;
  }
  if (typeof field.references === 'string' && field.references.length > 0) return 'integer';
  return undefined;
}

function columnTypesFromFields(
  fields: Array<[string, RawField]>,
  excludeColumn?: string,
): Record<string, CrudFieldType> {
  const columnTypes: Record<string, CrudFieldType> = {};
  for (const [name, f] of fields) {
    if (name === excludeColumn) continue;
    const type = inferredFieldType(f);
    if (type !== undefined) columnTypes[name] = type;
  }
  return columnTypes;
}

interface EagerWriteMaps {
  viewTypes: Map<string, RawViewType>;
  datasourceTypes: Map<string, RawType>;
}

interface ChildRef {
  childFieldName: string;
  elementType: string;
  refTable: string;
  refColumn: string;
  isArray: boolean;
}

function buildOneEagerWriteChild(
  parentViewName: string,
  childFieldName: string,
  maps: EagerWriteMaps,
): EagerWriteChildSpec | null {
  const parentView = maps.viewTypes.get(parentViewName);
  if (!parentView) return null;
  const parentFields = (parentView.fields ?? []).map((entry) => {
    const [name, def] = Object.entries(entry)[0];
    return [name, def] as [string, ViewTypeField];
  });

  const viewField = parentFields.find(([name]) => name === childFieldName);
  if (!viewField) return null;

  const [, fieldDef] = viewField;
  const typeMatch = parseRelationType(fieldDef.type);
  if (!typeMatch) return null;
  const refMatch = (fieldDef.references ?? '').match(/^datasource_types\.(\w+)\.(\w+)$/);
  if (!refMatch) return null;

  const ref: ChildRef = {
    childFieldName,
    elementType: typeMatch.elementType,
    refTable: refMatch[1],
    refColumn: refMatch[2],
    isArray: typeMatch.isArray,
  };
  return ref.refTable === ref.elementType
    ? buildDirectFkChild(ref, maps.datasourceTypes)
    : buildM2mChild(ref, maps.datasourceTypes);
}

function buildDirectFkChild(
  ref: ChildRef,
  datasourceTypes: Map<string, RawType>,
): EagerWriteChildSpec | null {
  const { childFieldName, elementType, refColumn, isArray } = ref;
  const childDatasource = datasourceTypes.get(elementType);
  if (!childDatasource) return null;
  const childFields = extractFields(childDatasource);
  const childColumns = childFields.map(([name]) => name).filter((name) => name !== refColumn);
  const childColumnTypes = columnTypesFromFields(childFields, refColumn);
  const childEnrichmentColumns = enrichmentColumnsFromMap(elementType, datasourceTypes);
  return {
    kind: 'direct-fk',
    fieldName: childFieldName,
    childTable: elementType,
    fkColumn: refColumn,
    childColumns,
    ...(Object.keys(childColumnTypes).length > 0 && { childColumnTypes }),
    ...(childEnrichmentColumns.length > 0 && { childEnrichmentColumns }),
    ...(!isArray && { isArray: false }),
  };
}

function buildM2mChild(
  ref: ChildRef,
  datasourceTypes: Map<string, RawType>,
): EagerWriteChildSpec | null {
  const { childFieldName, elementType, refTable, refColumn } = ref;
  const junctionDatasource = datasourceTypes.get(refTable);
  if (!junctionDatasource) return null;
  if (junctionDatasource.datasource_type !== 'many-to-many') return null;

  const junctionFields = extractFields(junctionDatasource);
  const targetFkEntry = junctionFields.find(([name, f]) => {
    if (name === refColumn) return false;
    if (typeof f.references !== 'string') return false;
    const dot = f.references.indexOf('.');
    if (dot <= 0) return false;
    return f.references.slice(0, dot) === elementType;
  });
  if (!targetFkEntry) return null;

  const targetDatasource = datasourceTypes.get(elementType);
  if (!targetDatasource) return null;
  const targetFields = extractFields(targetDatasource);
  const targetColumnTypes = columnTypesFromFields(targetFields);
  const targetEnrichmentColumns = enrichmentColumnsFromMap(elementType, datasourceTypes);
  return {
    kind: 'm2m',
    fieldName: childFieldName,
    childTable: elementType,
    junctionTable: refTable,
    parentFkColumn: refColumn,
    targetFkColumn: targetFkEntry[0],
    childColumns: targetFields.map(([name]) => name),
    ...(Object.keys(targetColumnTypes).length > 0 && { childColumnTypes: targetColumnTypes }),
    ...(targetEnrichmentColumns.length > 0 && { childEnrichmentColumns: targetEnrichmentColumns }),
    ...(!ref.isArray && { isArray: false }),
  };
}

interface EagerWriteDocs {
  datasourceDoc: unknown;
  routesDoc: unknown;
  viewTypesDoc?: unknown;
}

function indexByFirstKey<T>(entries: Array<Record<string, T>> | undefined): Map<string, T> {
  return new Map(
    (entries ?? []).map((entry) => {
      const [name, def] = Object.entries(entry)[0];
      return [name, def] as [string, T];
    }),
  );
}

/** Walk each eager-write path's segments, creating a child spec per field and chaining `childTable` as the next parent; intermediates shared across paths merge into one ordered bucket. */
function buildChildrenByParent(
  parentPaths: string[],
  maps: EagerWriteMaps,
): Map<string, Map<string, EagerWriteChildSpec>> {
  const childrenByParent = new Map<string, Map<string, EagerWriteChildSpec>>();
  for (const path of parentPaths) {
    const segments = path.split('.');
    let currentParentView = segments[0];
    for (let i = 1; i < segments.length; i++) {
      const fieldName = segments[i];
      if (!childrenByParent.has(currentParentView))
        childrenByParent.set(currentParentView, new Map());
      const bucket = childrenByParent.get(currentParentView)!;
      let spec = bucket.get(fieldName);
      if (!spec) {
        const built = buildOneEagerWriteChild(currentParentView, fieldName, maps);
        if (!built) break;
        spec = built;
        bucket.set(fieldName, spec);
      }
      currentParentView = spec.childTable;
    }
  }
  return childrenByParent;
}

function attachChildrenFor(
  viewName: string,
  childrenByParent: Map<string, Map<string, EagerWriteChildSpec>>,
): EagerWriteChildSpec[] | undefined {
  const bucket = childrenByParent.get(viewName);
  if (!bucket || bucket.size === 0) return undefined;
  const out: EagerWriteChildSpec[] = [];
  for (const spec of bucket.values()) {
    const nested = attachChildrenFor(spec.childTable, childrenByParent);
    if (nested && nested.length > 0) spec.children = nested;
    out.push(spec);
  }
  return out;
}

function extractEagerWriteChildren(
  entityName: string,
  docs: EagerWriteDocs,
): EagerWriteChildSpec[] {
  const rawPaths = routeViewTypeDirective(docs.routesDoc)?.eager_write_path;
  const eagerWritePaths = Array.isArray(rawPaths) ? (rawPaths as string[]) : [];
  const parentPaths = eagerWritePaths.filter((p) => {
    const segs = p.split('.');
    return segs.length >= 2 && segs[0] === entityName;
  });
  if (parentPaths.length === 0) return [];

  const maps: EagerWriteMaps = {
    viewTypes: indexByFirstKey<RawViewType>((docs.viewTypesDoc as ViewTypesDoc | null)?.types),
    datasourceTypes: indexByFirstKey<RawType>((docs.datasourceDoc as DatasourceDoc | null)?.types),
  };
  const childrenByParent = buildChildrenByParent(parentPaths, maps);
  return attachChildrenFor(entityName, childrenByParent) ?? [];
}

type ByFieldDecl = {
  entity?: string;
  byField?: string;
  methods?: string[];
};

type HttpMethod = 'GET' | 'PUT' | 'DELETE';
const SHORTHAND_VERB_RE = /^(get|put|delete)_/i;
const VERB_TO_METHODS: Record<string, HttpMethod[]> = {
  get: ['GET'],
  put: ['PUT'],
  delete: ['DELETE'],
};
const DEFAULT_METHODS: HttpMethod[] = ['GET', 'PUT', 'DELETE'];

function camelToSnake(camel: string): string {
  return camel
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function singularizeLastToken(snakePlural: string): string {
  const parts = snakePlural.split('_');
  if (parts.length === 0) return snakePlural;
  const last = parts[parts.length - 1];
  parts[parts.length - 1] = singularizeToken(last);
  return parts.join('_');
}

function indexEntities(datasourceDoc: unknown): Map<string, RawType> {
  const doc = (datasourceDoc as DatasourceDoc | null) ?? {};
  return new Map(
    (doc.types ?? []).map((entry) => {
      const [name, def] = Object.entries(entry)[0];
      return [name, def] as [string, RawType];
    }),
  );
}

function entityHasField(entityDef: RawType, fieldName: string): boolean {
  if (fieldName === 'id') return true;
  const fields = entityDef.fields ?? [];
  return fields.some((f) => Object.prototype.hasOwnProperty.call(f, fieldName));
}

function normalizeMethods(raw: unknown): HttpMethod[] {
  const list = Array.isArray(raw) ? raw : DEFAULT_METHODS;
  return list
    .map((m) => String(m).toUpperCase())
    .filter((m): m is HttpMethod => m === 'GET' || m === 'PUT' || m === 'DELETE');
}

function parseShorthandToken(
  token: string,
  entities: Map<string, RawType>,
): { entity: string; byField: string; methods: HttpMethod[] } {
  if (token.length === 0) {
    throw new Error(`collectByFieldRoutes: expected non-empty string token`);
  }
  let methods: HttpMethod[] = DEFAULT_METHODS;
  let body = token;
  const verbMatch = SHORTHAND_VERB_RE.exec(token);
  if (verbMatch) {
    methods = VERB_TO_METHODS[verbMatch[1].toLowerCase()];
    body = token.slice(verbMatch[0].length);
  }
  const splitIdx = body.lastIndexOf('_by_');
  if (splitIdx < 0) {
    throw new Error(`collectByFieldRoutes: route key \`${token}\` is missing \`_by_\` separator`);
  }
  const pluralSnake = body.slice(0, splitIdx);
  const camelField = body.slice(splitIdx + '_by_'.length);
  if (!pluralSnake || !camelField) {
    throw new Error(
      `collectByFieldRoutes: route key \`${token}\` has empty entity or field around \`_by_\``,
    );
  }
  const entity = singularizeLastToken(pluralSnake);
  const byField = camelToSnake(camelField);

  const entityDef = entities.get(entity);
  if (!entityDef) {
    throw new Error(`collectByFieldRoutes: unknown entity \`${entity}\` in route \`${token}\``);
  }
  if (!entityHasField(entityDef, byField)) {
    throw new Error(
      `collectByFieldRoutes: field \`${byField}\` not found on entity \`${entity}\` in route \`${token}\``,
    );
  }
  return { entity, byField, methods };
}

function collectByFieldRoutes(
  routesDoc: unknown,
  datasourceDoc: unknown,
): Map<string, ByFieldRouteSpec[]> {
  const out = new Map<string, ByFieldRouteSpec[]>();
  const list = (routesDoc as { routes?: unknown[] })?.routes;
  if (!Array.isArray(list)) return out;
  const entities = indexEntities(datasourceDoc);

  for (const entry of list) {
    if (entry == null) continue;
    let entity: string | null = null;
    let byField: string | null = null;
    let methods: HttpMethod[] = DEFAULT_METHODS;

    if (typeof entry === 'string') {
      const parsed = parseShorthandToken(entry, entities);
      entity = parsed.entity;
      byField = parsed.byField;
      methods = parsed.methods;
    } else if (typeof entry === 'object') {
      const pairs = Object.entries(entry as Record<string, unknown>);
      if (pairs.length === 0) continue;
      const [key, def] = pairs[0];
      if (def == null) {
        const parsed = parseShorthandToken(key, entities);
        entity = parsed.entity;
        byField = parsed.byField;
        methods = parsed.methods;
      } else if (typeof def === 'object') {
        const verbose = def as ByFieldDecl;
        if (typeof verbose.entity === 'string' && typeof verbose.byField === 'string') {
          entity = verbose.entity;
          byField = verbose.byField;
          methods = normalizeMethods(verbose.methods);
        } else {
          continue;
        }
      } else {
        continue;
      }
    } else {
      continue;
    }

    if (!entity || !byField) continue;
    const existing = out.get(entity) ?? [];
    existing.push({ field: byField, unique: false, methods });
    out.set(entity, existing);
  }
  return out;
}

const CRUD_FIELD_TYPES = new Set<CrudFieldType>([
  'string',
  'number',
  'integer',
  'smallinteger',
  'biginteger',
  'float',
  'boolean',
  'datetime',
  'uuid',
  'binary',
  'reference',
]);

function toCrudFieldDef(name: string, raw: RawField): CrudFieldDef | null {
  const inferred = inferredFieldType(raw);
  if (inferred === undefined) return null;
  const out: CrudFieldDef = { name, type: inferred };
  if (raw.size !== undefined) out.size = raw.size;
  if (raw.min_size !== undefined) out.min_size = raw.min_size;
  if (raw.is_nullable === true) out.is_nullable = true;
  if (typeof raw.references === 'string' && raw.references.length > 0) {
    out.references = raw.references;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'default_value')) {
    out.has_default_value = true;
    out.default_value = raw.default_value;
  }
  return out;
}

const idTypeFromField = (type: string | undefined): StandardIdType => {
  if (type === 'string' || type === 'uuid' || type === 'biginteger') return type;
  return 'integer';
};

/** Resolves the PK column for every entity so no downstream consumer has to literal-default it. A declared `primary_key: true` or overlay `is_fixed_id: true` non-id field (the `legacy_contact.key` pattern) sets both the column and its id shape (`string`/`uuid` skip parseInt; anything else keeps the integer contract). An authored `id` field supplies the implicit PK type. Otherwise the implicit auto-increment `id` is integer. Type-level `ids` and field `is_id` produce a composite or custom identity. */
function assignPrimaryKey(
  spec: CrudRouteSpec,
  fields: Array<[string, RawField]>,
  body: RawType,
): void {
  const fieldMap = new Map(fields);
  if (body.ids !== undefined && body.ids.length > 0) {
    spec.primaryKeyColumns = body.ids.map((column) => ({
      column,
      idType: idTypeFromField(fieldMap.get(column)?.type),
    }));
    spec.primaryKeyColumn = spec.primaryKeyColumns[0]!.column;
    spec.primaryKeyIdType = spec.primaryKeyColumns[0]!.idType;
    return;
  }
  const marked = fields.filter(([, f]) => f.is_id === true);
  if (marked.length > 0) {
    spec.primaryKeyColumns = marked.map(([column, f]) => ({
      column,
      idType: idTypeFromField(f.type),
    }));
    spec.primaryKeyColumn = spec.primaryKeyColumns[0]!.column;
    spec.primaryKeyIdType = spec.primaryKeyColumns[0]!.idType;
    return;
  }
  const idField = fields.find(([name]) => name === 'id');
  if (idField !== undefined) {
    spec.primaryKeyIdType = idTypeFromField(idField[1].type);
  }
  for (const [fieldName, fdef] of fields) {
    if (fieldName === 'id') continue;
    if (fdef.primary_key !== true && fdef.is_fixed_id !== true) continue;
    spec.primaryKeyColumn = fieldName;
    spec.primaryKeyIdType = idTypeFromField(fdef.type);
    spec.primaryKeyColumns = [{ column: fieldName, idType: spec.primaryKeyIdType }];
    return;
  }
  spec.primaryKeyColumns = [{ column: spec.primaryKeyColumn, idType: spec.primaryKeyIdType }];
}

interface CrudSpecContext {
  datasourceDoc: unknown;
  routesDoc: unknown;
  viewTypesDoc?: unknown;
  typesByName: Map<string, RawType>;
  overlayFields: Map<string, Map<string, RawField>>;
  nestedOnlyNames: ReturnType<typeof collectNestedOnlyEntities>;
  byFieldByEntity: ReturnType<typeof collectByFieldRoutes>;
}

function resolveEagerChildren(entityName: string, ctx: CrudSpecContext): EagerWriteChildSpec[] {
  if (!ctx.viewTypesDoc) return [];
  return extractEagerWriteChildren(entityName, ctx);
}

function mergeOverlayFields(
  fields: Array<[string, RawField]>,
  overlay: Map<string, RawField> | undefined,
): Array<[string, RawField]> {
  if (overlay === undefined || overlay.size === 0) return fields;
  const seen = new Set(fields.map(([name]) => name));
  const merged = fields.map(([name, field]) => {
    const extra = overlay.get(name);
    return extra === undefined ? [name, field] : [name, { ...field, ...extra }];
  }) as Array<[string, RawField]>;
  for (const [name, field] of overlay) {
    if (!seen.has(name)) merged.push([name, field]);
  }
  return merged;
}

function overlayFieldsByEntity(overlaysDoc: unknown): Map<string, Map<string, RawField>> {
  const out = new Map<string, Map<string, RawField>>();
  for (const [entityName, body] of readTypes(overlaysDoc)) {
    const fields = extractFields(body);
    if (fields.length === 0) continue;
    out.set(entityName, new Map(fields));
  }
  return out;
}

/** Resolve each by-field route's uniqueness from its field def (primary_key OR is_unique). Returns undefined when the entity has no by-field routes. */
function resolveByFields(
  byFieldByEntity: ReturnType<typeof collectByFieldRoutes>,
  entityName: string,
  fields: Array<[string, RawField]>,
): CrudRouteSpec['byFields'] {
  const byFields = byFieldByEntity.get(entityName);
  if (!byFields || byFields.length === 0) return undefined;
  const fieldDefByName = new Map(fields);
  return byFields.map((bf) => {
    const fdef = fieldDefByName.get(bf.field);
    return { ...bf, unique: Boolean(fdef?.is_unique || fdef?.primary_key || fdef?.is_fixed_id) };
  });
}

function buildCrudSpec(entityName: string, body: RawType, ctx: CrudSpecContext): CrudRouteSpec {
  const fields = mergeOverlayFields(
    flattenTypeFields(entityName, ctx.typesByName),
    ctx.overlayFields.get(entityName),
  ).filter(([, field]) => !isCollectionType(field.type));
  const columnTypes = columnTypesFromFields(fields);
  const enrichmentColumns = enrichmentColumnsFromFields(fields, ctx);
  const crudFields = fields
    .map(([name, f]) => toCrudFieldDef(name, f))
    .filter((f): f is CrudFieldDef => f !== null);
  const tags = body.tags ?? [];

  const spec: CrudRouteSpec = {
    pathSegment: kebabPlural(entityName),
    entityName,
    // Implicit auto-increment `id` is integer; assignPrimaryKey overrides when the entity authors `id` or a custom primary_key.
    primaryKeyColumn: 'id',
    primaryKeyIdType: 'integer',
    primaryKeyColumns: [{ column: 'id', idType: 'integer' }],
    columns: fields.map(([name]) => name),
    ...((body.datasource_type === 'readonly-lookup' || tags.includes('readonly_lookup')) && {
      readonly: true,
    }),
    ...((body.datasource_type === 'many-to-many' || tags.includes('many_to_many')) && { m2m: true }),
    ...(tags.includes('view_type') && { replaceLookupFks: true }),
    ...(ctx.nestedOnlyNames.has(entityName) && { nestedOnly: true }),
    ...(Object.keys(columnTypes).length > 0 && { columnTypes }),
    ...(enrichmentColumns.length > 0 && { enrichmentColumns }),
    ...(crudFields.length > 0 && { fields: crudFields }),
  };

  assignPrimaryKey(spec, fields, body);

  const eagerWriteChildren = resolveEagerChildren(entityName, ctx);
  if (eagerWriteChildren.length > 0) spec.eagerWriteChildren = eagerWriteChildren;

  const byFields = resolveByFields(ctx.byFieldByEntity, entityName, fields);
  if (byFields) spec.byFields = byFields;

  return spec;
}

export function parseCrudRouteSpecs(
  datasourceDoc: unknown,
  routesDoc: unknown,
  opts?: { viewTypesDoc?: unknown; overlaysDoc?: unknown },
): CrudRouteSpec[] {
  const types = readTypes(datasourceDoc);
  const ctx: CrudSpecContext = {
    datasourceDoc,
    routesDoc,
    viewTypesDoc: opts?.viewTypesDoc,
    typesByName: new Map(types),
    overlayFields: overlayFieldsByEntity(opts?.overlaysDoc),
    nestedOnlyNames: collectNestedOnlyEntities(routesDoc, types),
    byFieldByEntity: collectByFieldRoutes(routesDoc, datasourceDoc),
  };
  return types.map(([entityName, body]) => buildCrudSpec(entityName, body, ctx));
}
