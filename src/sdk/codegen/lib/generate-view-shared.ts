import { INLINED_VIEW_AUDIT_FIELDS as STANDARD_DATASOURCE_FIELDS } from "./standard-columns.ts";

/** A datasource type's declared field, normalized to codegen-neutral shape. */
export interface DeclaredField {
  name: string;
  type: string;
  isNullable: boolean;
}

interface DatasourceFieldDef {
  type: string;
  is_nullable?: boolean;
}

/** A datasource type definition: an ordered list of `{ name: fieldDef }` columns. */
export interface DatasourceTypeDef {
  fields?: Array<Record<string, DatasourceFieldDef>>;
}

/** A datasource, whose `types` list pairs each type name with its definition. */
export interface Datasource {
  types?: Array<Record<string, DatasourceTypeDef>>;
}

/** A field's parsed kind/base as resolved by the view expander. */
export interface ParsedField {
  kind: string;
  base: string;
  isArray: boolean;
}

/** A shaped view's declared field. */
export interface ViewField {
  name: string;
  isNullable?: boolean;
  parsed: ParsedField;
}

/** An enrichment column a shaped view replaces on its parent: the parent `fkColumn` dropped and the `newField` substituted in its place. */
export interface ViewEnrichment {
  fkColumn: string;
  newField?: string;
}

/** A shaped view: a struct/interface inheriting a datasource type plus declared fields. */
export interface ShapedView {
  kind: "shaped";
  name: string;
  inherits?: string | null;
  fields: ViewField[];
  enrichments: ViewEnrichment[];
  omit: string[];
}

/** A union view: a tagged union over sibling view members. */
export interface UnionView {
  kind: "union";
  name: string;
  members: string[];
}

/** A normalized view (shaped or union) as produced by the view expander. */
export type View = ShapedView | UnionView;

/** The `generate(config)` façade every view lane returns from `createGenerator`. */
export interface ViewGenerator<S> {
  generate: (config: { settings: S }) => unknown;
}

interface BaseViewGenerator {
  generate: (config: Record<string, unknown>) => unknown;
}

type ImportsCtor = new (ctx: any) => unknown;

/** The definition object of a datasource type by name, or null when absent. */
export function findDatasourceTypeDef(
  datasource: Datasource | null | undefined,
  tableName: string,
): DatasourceTypeDef | null {
  const entry = (datasource?.types ?? []).find(
    (e) => Object.keys(e)[0] === tableName,
  );
  return entry ? Object.values(entry)[0] : null;
}

/** A datasource type's declared columns as `{ name, type, isNullable }`. */
export function declaredFieldsOf(def: DatasourceTypeDef): DeclaredField[] {
  return (def.fields ?? []).map((f) => {
    const [name, fdef] = Object.entries(f)[0];
    return { name, type: fdef.type, isNullable: fdef.is_nullable === true };
  });
}

/** Fields a view inherits from a datasource type: the standard audit columns (minus any the type redeclares) followed by the type's declared fields. Rust has its own audit-field logic and does not use this. */
export function inheritedDatasourceFields(
  datasource: Datasource,
  tableName: string,
): DeclaredField[] {
  const def = findDatasourceTypeDef(datasource, tableName);
  if (!def) return [];
  const declared = declaredFieldsOf(def);
  const declaredNames = new Set(declared.map((f) => f.name));
  const standards = STANDARD_DATASOURCE_FIELDS.filter(
    (f: DeclaredField) => !declaredNames.has(f.name),
  );
  return [...standards, ...declared];
}

/** True when a shaped view has any array field, so the lane must import its List/array type. */
export function needsListImport(view: {
  kind: string;
  fields: ViewField[];
}): boolean {
  return view.kind === "shaped" && view.fields.some((f) => f.parsed.isArray);
}

/** Dispatch a view to its `shaped` or `union` renderer — the branch every view lane repeats. */
export function renderByViewKind<V extends { kind: string }, C, R>(
  view: V,
  ctx: C,
  handlers: { shaped: (v: V, c: C) => R; union: (v: V, c: C) => R },
): R {
  return view.kind === "union"
    ? handlers.union(view, ctx)
    : handlers.shaped(view, ctx);
}

/** Doc-comment description lines for a shaped view (shared across every view lane). */
export function shapedViewDocLines(view: ShapedView): string[] {
  return [
    `Datasource type: ${view.inherits ?? "standard"}.`,
    `Target: ShapedView.`,
    `Fields: ${view.fields?.length ?? 0}.`,
  ];
}

/** Doc-comment description lines for a union view (shared across every view lane). */
export function unionViewDocLines(view: UnionView): string[] {
  return [
    `Datasource type: standard.`,
    `Target: UnionView.`,
    `Fields: ${view.members.length}.`,
  ];
}

/** Classify a shaped view's inheritance rendering mode for the struct-inlining lanes (rust/csharp): `inlineParent` (enrichments inline the parent's fields), `inlineForOmit` (omit list inlines them), and `aliasParent` (empty view that is a bare alias of the parent). `enrichments`/`omitList` are returned for the caller's field-omission sets. */
export function classifyViewShape(view: ShapedView) {
  const enrichments = view.enrichments ?? [];
  const inlineParent = enrichments.length > 0 && view.inherits;
  const omitList = Array.isArray(view.omit) ? view.omit : [];
  const inlineForOmit = !inlineParent && view.inherits && omitList.length > 0;
  const aliasParent =
    view.inherits &&
    (view.fields?.length ?? 0) === 0 &&
    !inlineParent &&
    !inlineForOmit;
  return { enrichments, inlineParent, inlineForOmit, omitList, aliasParent };
}

/** The shared `createGenerator` tail for the struct-inlining view lanes: bind the imports adapter, then merge `defaults` + settings-derived options under the dispatched config. `optionsFromSettings` is the only per-lane variation (datasource repr for rust, datetime for csharp). */
export function buildViewGenerator<S>(spec: {
  baseCreateGenerator: (Imports?: ImportsCtor) => BaseViewGenerator;
  imports: ImportsCtor;
  defaults: Record<string, unknown>;
  optionsFromSettings: (settings: S) => Record<string, unknown>;
}): ViewGenerator<S> {
  const base = spec.baseCreateGenerator(spec.imports);
  return {
    generate: (config) =>
      base.generate({
        ...spec.defaults,
        ...spec.optionsFromSettings(config.settings),
        ...config,
      }),
  };
}
