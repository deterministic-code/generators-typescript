import { normalizeAll } from "../../view-expand.ts";
import type {
  NormalizedView,
  ParsedFieldType,
  ShapedField,
  ShapedView,
  UnionView,
} from "../../view-expand.ts";
import { datasourceSettingsFor } from "./ts-datasource-settings.ts";
import { RuntimeValue } from "./ts-sample-literal.ts";

const STANDARD_COLUMNS = ["id", "uuid", "created", "updated"];
const MUTABLE_SCALAR_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "datetime",
  "reference",
  "binary",
]);

type Fixture = Record<string, unknown>;

interface DatasourceField {
  name: string;
  type: string;
  size?: number;
  references?: string;
  isNullable: boolean;
  hasDefault: boolean;
  defaultValue?: unknown;
}

interface DatasourceDef {
  name: string;
  datasourceType: string | null;
  fields: DatasourceField[];
}

interface RawDatasourceFieldDef {
  type?: string;
  size?: number;
  references?: string;
  is_nullable?: boolean;
  default_value?: unknown;
}

type RawDatasourceEntry = Record<
  string,
  {
    fields?: Record<string, RawDatasourceFieldDef>[];
    datasource_type?: string;
  }
>;

interface Mutation {
  description: string;
  mutate: (fx: Fixture) => Fixture;
}

interface ViewCtx {
  viewsIndex: Map<string, NormalizedView>;
  datasource: unknown;
  visited: Set<string>;
  datetime: string;
  idType: string;
}

interface DatasourceFixtureArgs {
  table: string;
  datasource: unknown;
  nullableVariant?: boolean;
  datetime?: string;
  idType?: string;
}

interface ViewFixtureArgs {
  view: string;
  viewTypes: unknown;
  datasource: unknown;
  nullableVariant?: boolean;
  allMembers?: boolean;
  datetime?: string;
  idType?: string;
}

interface MutationArgs {
  table?: string;
  view?: string;
  viewTypes?: unknown;
  datasource: unknown;
}

function entryOf<T>(
  obj: Record<string, T> | null | undefined,
): [string, T] | null {
  if (!obj || typeof obj !== "object") return null;
  const keys = Object.keys(obj);
  if (keys.length === 0) return null;
  return [keys[0], obj[keys[0]]];
}

function indexDatasource(datasource: unknown): Map<string, DatasourceDef> {
  const index = new Map<string, DatasourceDef>();
  const types = (datasource as { types?: RawDatasourceEntry[] }).types ?? [];
  for (const entry of types) {
    const pair = entryOf(entry);
    if (!pair) continue;
    const [name, def] = pair;
    const fields = (def.fields ?? []).map((f) => {
      const [fname, fdef] = Object.entries(f)[0];
      return {
        name: fname,
        type: fdef.type as string,
        size: fdef.size,
        references: fdef.references,
        isNullable: fdef.is_nullable === true,
        hasDefault: Object.prototype.hasOwnProperty.call(fdef, "default_value"),
        defaultValue: fdef.default_value,
      };
    });
    index.set(name, {
      name,
      datasourceType: def.datasource_type ?? null,
      fields,
    });
  }
  return index;
}

function indexViews(viewTypes: unknown): Map<string, NormalizedView> {
  const index = new Map<string, NormalizedView>();
  for (const normalized of normalizeAll(viewTypes ?? { types: [] })) {
    index.set(normalized.name, normalized);
  }
  return index;
}

function samplePrimitive(
  type: string,
  size: number | undefined,
  datetime = "string",
): unknown {
  switch (type) {
    case "string":
    case "character":
      return new RuntimeValue("string", { size });
    case "decimal":
      return new RuntimeValue("string", {});
    case "uuid":
      return new RuntimeValue("uuid");
    case "number":
    case "integer":
    case "smallinteger":
    case "biginteger":
    case "reference":
      return 1;
    case "float":
      return 1.0;
    case "boolean":
      return true;
    case "datetime":
      return new RuntimeValue("datetime", { datetime });
    case "binary":
      return new Uint8Array(0);
    default:
      throw new Error(`Unknown primitive type: ${type}`);
  }
}

function standardColumnValue(
  column: string,
  opts: { datetime: string; idType: string },
): unknown {
  switch (column) {
    case "id":
      return datasourceSettingsFor({ idType: opts.idType }).sampleId();
    case "uuid":
      return new RuntimeValue("uuid");
    case "created":
    case "updated":
      return new RuntimeValue("datetime", { datetime: opts.datetime });
    default:
      throw new Error(`Unknown standard column: ${column}`);
  }
}

/** The system columns a fixture carries under this id_type — mirrors the schema generator, which drops the separate `uuid` column when the primary key IS the uuid. */
function standardColumnsFor(idType: string): string[] {
  return idType === "uuid"
    ? STANDARD_COLUMNS.filter((c) => c !== "uuid")
    : STANDARD_COLUMNS;
}

function valueForDatasourceField(
  field: DatasourceField,
  opts: { nullableVariant?: boolean; datetime: string; idType: string },
): unknown {
  if (field.isNullable && opts.nullableVariant) return null;
  if (
    field.hasDefault &&
    field.defaultValue !== null &&
    field.defaultValue !== undefined
  ) {
    return field.defaultValue;
  }
  const ds = datasourceSettingsFor({ idType: opts.idType });
  if (field.type !== "uuid" && ds.referenceIsUuid(field.references)) {
    return ds.sampleId();
  }
  return samplePrimitive(field.type, field.size, opts.datetime);
}

export function buildDatasourceFixture({
  table,
  datasource,
  nullableVariant = false,
  datetime = "string",
  idType = "integer",
}: DatasourceFixtureArgs): Fixture {
  const def = indexDatasource(datasource).get(table);
  if (!def) throw new Error(`buildDatasourceFixture: unknown table "${table}"`);
  const fixture: Fixture = {};
  for (const col of standardColumnsFor(idType)) {
    fixture[col] = standardColumnValue(col, { datetime, idType });
  }
  for (const field of def.fields) {
    fixture[field.name] = valueForDatasourceField(field, {
      nullableVariant,
      datetime,
      idType,
    });
  }
  return fixture;
}

function sampleElementForParsedType(
  parsed: ParsedFieldType,
  ctx: ViewCtx,
): unknown {
  if (parsed.kind === "primitive") {
    return samplePrimitive(parsed.base, undefined, ctx.datetime);
  }
  if (parsed.kind === "datasource") {
    return buildDatasourceFixture({
      table: parsed.base,
      datasource: ctx.datasource,
      datetime: ctx.datetime,
      idType: ctx.idType,
    });
  }
  if (parsed.kind === "view") {
    if (ctx.visited.has(parsed.base)) return {};
    return buildViewFixtureInner(parsed.base, ctx, { nullableVariant: false });
  }
  throw new Error(`Unknown parsed kind: ${parsed.kind}`);
}

function valueForViewField(
  field: ShapedField,
  ctx: ViewCtx,
  nullableVariant: boolean,
): unknown {
  if (field.isNullable && nullableVariant && !field.parsed.isArray) return null;
  const { parsed } = field;
  if (parsed.isArray) {
    return [sampleElementForParsedType(parsed, ctx)];
  }
  return sampleElementForParsedType(parsed, ctx);
}

function omitSet(view: ShapedView): Set<string | undefined> {
  const omit = new Set<string | undefined>(
    (view.enrichments ?? []).map((e: { fkColumn?: string }) => e.fkColumn),
  );
  for (const field of (view.omit ?? []) as string[]) omit.add(field);
  return omit;
}

function buildShapedViewFixture(
  view: ShapedView,
  ctx: ViewCtx,
  { nullableVariant }: { nullableVariant: boolean },
): Fixture {
  const fixture: Fixture = {};
  if (view.inherits) {
    const inherited = buildDatasourceFixture({
      table: view.inherits,
      datasource: ctx.datasource,
      nullableVariant,
      datetime: ctx.datetime,
      idType: ctx.idType,
    });
    const omit = omitSet(view);
    for (const [k, v] of Object.entries(inherited)) {
      if (omit.has(k)) continue;
      fixture[k] = v;
    }
  }
  for (const field of view.fields) {
    fixture[field.name] = valueForViewField(field, ctx, nullableVariant);
  }
  return fixture;
}

function buildUnionMemberFixtures(
  view: UnionView,
  ctx: ViewCtx,
): { memberName: string; fixture: Fixture }[] {
  return (view.members as string[]).map((memberName) => ({
    memberName,
    fixture: buildViewFixtureInner(memberName, ctx, { nullableVariant: false }),
  }));
}

function buildViewFixtureInner(
  viewName: string,
  ctx: ViewCtx,
  { nullableVariant }: { nullableVariant: boolean },
): Fixture {
  const view = ctx.viewsIndex.get(viewName);
  if (!view) throw new Error(`buildViewFixture: unknown view "${viewName}"`);
  if (ctx.visited.has(viewName)) return {};
  ctx.visited.add(viewName);
  try {
    if (view.kind === "union") {
      return buildViewFixtureInner(view.members[0], ctx, {
        nullableVariant: false,
      });
    }
    return buildShapedViewFixture(view, ctx, { nullableVariant });
  } finally {
    ctx.visited.delete(viewName);
  }
}

export function buildViewFixture({
  view,
  viewTypes,
  datasource,
  nullableVariant = false,
  allMembers = false,
  datetime = "string",
  idType = "integer",
}: ViewFixtureArgs): Fixture | { memberName: string; fixture: Fixture }[] {
  const viewsIndex = indexViews(viewTypes);
  const ctx: ViewCtx = {
    viewsIndex,
    datasource,
    visited: new Set(),
    datetime,
    idType,
  };
  const v = viewsIndex.get(view);
  if (!v) throw new Error(`buildViewFixture: unknown view "${view}"`);
  if (v.kind === "union" && allMembers) {
    return buildUnionMemberFixtures(v, ctx);
  }
  return buildViewFixtureInner(view, ctx, { nullableVariant });
}

function wrongTypeFor(primitive: string): number | string | null {
  switch (primitive) {
    case "string":
      return 123;
    case "number":
    case "reference":
      return "not-a-number";
    case "boolean":
      return "not-a-boolean";
    case "datetime":
      return 42;
    case "binary":
      return "not-binary";
    default:
      return null;
  }
}

function missingFieldMutation(name: string, prefix: string): Mutation {
  return {
    description: `${prefix} "${name}"`,
    mutate: (fx) => {
      const next = { ...fx };
      delete next[name];
      return next;
    },
  };
}

function nullFieldMutation(name: string, prefix: string): Mutation {
  return {
    description: `${prefix} "${name}"`,
    mutate: (fx) => ({ ...fx, [name]: null }),
  };
}

function wrongTypeMutation(name: string, primitive: string): Mutation {
  return {
    description: `wrong type on field "${name}"`,
    mutate: (fx) => ({ ...fx, [name]: wrongTypeFor(primitive) }),
  };
}

function collectDatasourceMutations(
  table: string,
  datasource: unknown,
): Mutation[] {
  const def = indexDatasource(datasource).get(table);
  if (!def) {
    throw new Error(`enumerateInvalidMutations: unknown table "${table}"`);
  }
  const mutations: Mutation[] = [];
  for (const field of def.fields) {
    if (!field.isNullable) {
      if (!field.hasDefault) {
        mutations.push(
          missingFieldMutation(field.name, "missing required field"),
        );
      }
      mutations.push(
        nullFieldMutation(field.name, "null for non-nullable field"),
      );
    }
    if (MUTABLE_SCALAR_TYPES.has(field.type)) {
      mutations.push(wrongTypeMutation(field.name, field.type));
    }
  }
  return mutations;
}

function primitiveKindFor(parsed: ParsedFieldType): string | null {
  if (parsed.kind === "primitive") return parsed.base;
  return null;
}

function inheritedFieldMutations(
  view: ShapedView,
  datasource: unknown,
): Mutation[] {
  if (!view.inherits) return [];
  const dsDef = indexDatasource(datasource).get(view.inherits);
  if (!dsDef) return [];
  const omit = omitSet(view);
  const mutations: Mutation[] = [];
  for (const field of dsDef.fields) {
    if (omit.has(field.name)) continue;
    if (!field.isNullable && !field.hasDefault) {
      mutations.push(
        missingFieldMutation(field.name, "missing inherited required field"),
      );
      mutations.push(
        nullFieldMutation(field.name, "null for non-nullable inherited field"),
      );
      break;
    }
  }
  return mutations;
}

function shapedFieldMutations(view: ShapedView): Mutation[] {
  const mutations: Mutation[] = [];
  for (const field of view.fields) {
    if (!field.isNullable && !field.parsed.isArray) {
      mutations.push(
        missingFieldMutation(field.name, "missing required field"),
      );
      mutations.push(
        nullFieldMutation(field.name, "null for non-nullable field"),
      );
    }
    const prim = primitiveKindFor(field.parsed);
    if (prim && !field.parsed.isArray) {
      mutations.push(wrongTypeMutation(field.name, prim));
    }
  }
  return mutations;
}

function collectViewMutations(
  viewName: string,
  viewTypes: unknown,
  datasource: unknown,
): Mutation[] {
  const view = indexViews(viewTypes).get(viewName);
  if (!view) {
    throw new Error(`enumerateInvalidMutations: unknown view "${viewName}"`);
  }
  if (view.kind === "union") {
    return [
      {
        description: `matches neither member of union "${viewName}"`,
        mutate: () => ({ __not_a_member__: true }),
      },
    ];
  }
  return [
    ...inheritedFieldMutations(view, datasource),
    ...shapedFieldMutations(view),
  ];
}

export function enumerateInvalidMutations(args: MutationArgs): Mutation[] {
  if (args.table) {
    return collectDatasourceMutations(args.table, args.datasource);
  }
  if (args.view) {
    return collectViewMutations(args.view, args.viewTypes, args.datasource);
  }
  throw new Error("enumerateInvalidMutations: must pass `table` or `view`");
}

export { indexDatasource };
