import { parse, stringify } from "yaml";
import { combineDatasourceTypes } from "./datasource-types-combine.ts";
import { mergeCustomMigrations } from "./custom-migrations-merge.ts";
import { emptyReport, mergeReports } from "./types-combine-core.ts";
import type { JsonValue } from "../read-settings.ts";
import type {
  RawTypesDoc,
  RawIncludeEntry,
} from "../deterministic-shapes.ts";
import type { CustomMigrationPair } from "./custom-migrations-manifest.ts";

type CombineReport = ReturnType<typeof emptyReport>;
type CustomMigrations = Record<string, CustomMigrationPair[]>;
type TypeEntry = Record<string, JsonValue>;

type IncludeSideOptions = Record<string, string[]>;

interface IncludeCombineOptions {
  source?: IncludeSideOptions;
  destination?: IncludeSideOptions;
}

export interface FoldableInclude {
  file?: string;
  id?: string | number;
  uuid?: string;
  user_id?: string | number;
  name?: string;
  combine_options?: IncludeCombineOptions;
}

export interface ResolveCtx {
  datasourceYaml?: string | null;
  datasourceData?: JsonValue | null;
  baseDir?: string;
  visited?: Set<string>;
}

export interface LoadedInclude {
  text: string;
  key: string;
  ctx: ResolveCtx;
  datasourceText?: string | null;
  customMigrations?: CustomMigrations;
}

type Load = (
  include: FoldableInclude,
  ctx: ResolveCtx,
) => Promise<LoadedInclude>;

interface CombineResult {
  yaml: string;
  report: CombineReport;
}

export interface ResolveResult {
  yaml: string;
  datasourceYaml: string | null;
  report: CombineReport;
  customMigrations: CustomMigrations;
}

type Resolve = (
  rootYaml: string,
  load: Load,
  ctx?: ResolveCtx,
) => Promise<ResolveResult>;

type DirectiveOf = (includes: RawIncludeEntry[]) => RawIncludeEntry | null;

interface CombineArgs {
  childYaml: string;
  accYaml: string;
  include: FoldableInclude;
  accDatasourceYaml: string | null;
}

type Combine = (args: CombineArgs) => CombineResult;

type FlatCombiner = (
  childYaml: string,
  accYaml: string,
  options: IncludeCombineOptions,
) => CombineResult;

/** True for a foldable include reference — `file:`, `id:`, `uuid:`, or `user_id`+`name` — as opposed to a directive entry (`datasource_types` / `view_type_services`). */
function isReferenceInclude(e: RawIncludeEntry): boolean {
  return (
    !!e &&
    (e.file !== undefined ||
      e.id !== undefined ||
      e.uuid !== undefined ||
      (e.user_id !== undefined && e.name !== undefined))
  );
}

/** The foldable include entries (see `isReferenceInclude`) as opposed to directive entries. */
export function fileIdIncludes(includes: RawIncludeEntry[]): FoldableInclude[] {
  return (Array.isArray(includes) ? includes : []).filter(
    isReferenceInclude,
  ) as FoldableInclude[];
}

/** The document without its `includes:` block (the resolver owns include resolution). */
function withoutIncludes(doc: RawTypesDoc): RawTypesDoc {
  const rest = { ...doc };
  delete rest.includes;
  return rest;
}

/** Re-attach the preserved directive entry as the sole `includes:` entry of a resolved YAML. */
function reattachDirective(
  yaml: string,
  directive: RawIncludeEntry | null,
): string {
  if (!directive) return yaml;
  return stringify({ includes: [directive], ...(parse(yaml) as RawTypesDoc) });
}

/** The base datasource YAML for reference validation / fold — `ctx.datasourceYaml` wins; a pre-parsed `ctx.datasourceData` (the edit-endpoint shape) is stringified as a fallback. */
function baseDatasourceYamlOf(ctx: ResolveCtx): string | null {
  if (ctx.datasourceYaml != null) return ctx.datasourceYaml;
  if (ctx.datasourceData != null) return stringify(ctx.datasourceData);
  return null;
}

/** A key-order-independent serialization, so a type re-included from the same source compares equal after round-tripping through combine. */
function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const typeName = (entry: TypeEntry): string => Object.keys(entry)[0];

/**
 * Fold one included datasource YAML into the accumulator (as combine source). A
 * null accumulator adopts the include wholesale. Types already present in the
 * accumulator with an IDENTICAL definition are dropped first — so a deterministic
 * referenced in BOTH datasource_types.yaml (which merged it into the base) and a
 * sibling config (view_types / services) re-folds to a no-op instead of a
 * duplicate-type collision. A same-named type with a DIFFERENT definition is kept,
 * so `combineDatasourceTypes` still surfaces it as a genuine conflict.
 */
function foldDatasource(
  accYaml: string | null,
  addYaml: string | null | undefined,
): string | null {
  if (addYaml == null) return accYaml;
  if (accYaml == null) return addYaml;
  const add = (parse(addYaml) as { types?: TypeEntry[] } | null) ?? {};
  const accDoc = (parse(accYaml) as { types?: TypeEntry[] } | null) ?? {};
  const accByName = new Map(
    (accDoc.types ?? []).map((t): [string, string] => [
      typeName(t),
      stableStringify(t),
    ]),
  );
  const fresh = (add.types ?? []).filter(
    (t) => accByName.get(typeName(t)) !== stableStringify(t),
  );
  if (fresh.length === 0) return accYaml;
  return combineDatasourceTypes(stringify({ ...add, types: fresh }), accYaml)
    .yaml;
}

interface FoldIncludesInput {
  fileIds: FoldableInclude[];
  load: Load;
  ctx: ResolveCtx;
  resolveChild: Resolve;
}

interface FoldedEntry {
  include: FoldableInclude;
  child: ResolveResult;
}

interface FoldIncludesResult {
  folded: FoldedEntry[];
  accDatasourceYaml: string | null;
  customMigrations: CustomMigrations;
  reports: CombineReport[];
}

/**
 * Fold each `file:`/`id:` include (recursively, via `resolveChild`) onto a running
 * accumulator, threading the included datasources so the caller validates against
 * the complete model. Includes are folded in reverse so listed order is preserved
 * and the including config's own entries come last. `load` returns
 * `{ text, key, ctx, datasourceText?, customMigrations? }`; `ctx.visited` catches
 * cycles. Returns the resolved children (in fold order) with the combined
 * datasource, merged custom migrations, and their reports.
 */
async function foldIncludes({
  fileIds,
  load,
  ctx,
  resolveChild,
}: FoldIncludesInput): Promise<FoldIncludesResult> {
  const visited = ctx.visited ?? new Set<string>();
  const customMigrations: CustomMigrations = {};
  const reports: CombineReport[] = [];
  const folded: FoldedEntry[] = [];
  let accDatasourceYaml = baseDatasourceYamlOf(ctx);

  for (const include of [...fileIds].reverse()) {
    const loaded = await load(include, ctx);
    if (visited.has(loaded.key)) {
      throw new Error(`include cycle detected at '${loaded.key}'`);
    }
    accDatasourceYaml = foldDatasource(
      accDatasourceYaml,
      loaded.datasourceText,
    );
    mergeCustomMigrations(
      customMigrations,
      loaded.customMigrations,
      loaded.key,
    );
    const child = await resolveChild(loaded.text, load, {
      ...loaded.ctx,
      datasourceYaml: accDatasourceYaml,
      visited: new Set(visited).add(loaded.key),
    });
    accDatasourceYaml = child.datasourceYaml ?? accDatasourceYaml;
    mergeCustomMigrations(customMigrations, child.customMigrations, loaded.key);
    reports.push(child.report);
    folded.push({ include, child });
  }
  return { folded, accDatasourceYaml, customMigrations, reports };
}

/**
 * Build a `resolve(rootYaml, load, ctx)` for a config's top-level `includes:`.
 * The single directive entry (`directiveOf(includes)`) is NOT a combine include —
 * it survives resolution (re-attached as the sole `includes:` entry) for a later
 * step to consume. Each `file:`/`id:` include is folded in reverse (listed order
 * preserved, this config's own entries last) via `combine({ childYaml, accYaml,
 * include, accDatasourceYaml })`, which returns `{ yaml, report }`. Included
 * datasources are threaded through `ctx.datasourceYaml` and returned so the caller
 * writes the merged model back. `ctx.visited` catches cycles.
 */
export function makeResolveIncludes({
  directiveOf,
  combine,
}: {
  directiveOf: DirectiveOf;
  combine: Combine;
}): Resolve {
  async function resolve(
    rootYaml: string,
    load: Load,
    ctx: ResolveCtx = {},
  ): Promise<ResolveResult> {
    const doc = (parse(rootYaml) as RawTypesDoc | null) ?? {};
    const includes = Array.isArray(doc.includes) ? doc.includes : [];
    const directive = directiveOf(includes);
    const fileIds = fileIdIncludes(includes);
    if (fileIds.length === 0) {
      return {
        yaml: rootYaml,
        datasourceYaml: baseDatasourceYamlOf(ctx),
        report: emptyReport(),
        customMigrations: {},
      };
    }

    const { folded, accDatasourceYaml, customMigrations, reports } =
      await foldIncludes({ fileIds, load, ctx, resolveChild: resolve });

    let accYaml = stringify(withoutIncludes(doc));
    for (const { include, child } of folded) {
      const combined = combine({
        childYaml: child.yaml,
        accYaml,
        include,
        accDatasourceYaml,
      });
      reports.push(combined.report);
      accYaml = combined.yaml;
    }

    return {
      yaml: reattachDirective(accYaml, directive),
      datasourceYaml: accDatasourceYaml,
      report: mergeReports(reports),
      customMigrations,
    };
  }
  return resolve;
}

/**
 * A resolver for a FLAT-entry artifact (services / routes): the single
 * `directiveKey` entry (`view_type_services` / `view_type_routes`) survives
 * resolution, and each `file:`/`id:` include is folded via
 * `combineFlat(childYaml, accYaml, options)`. The included `id:` datasource is
 * threaded through and returned so generate sees the merged model.
 */
export function makeFlatIncludeResolver(
  directiveKey: string,
  combineFlat: FlatCombiner,
): Resolve {
  return makeResolveIncludes({
    directiveOf: (includes) =>
      includes.find((e) => e && e[directiveKey] !== undefined) ?? null,
    combine: ({ childYaml, accYaml, include }) =>
      combineFlat(childYaml, accYaml, { ...(include.combine_options ?? {}) }),
  });
}
