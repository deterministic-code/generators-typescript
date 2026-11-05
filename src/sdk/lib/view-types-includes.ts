import { parse } from "yaml";
import { combineViewTypes } from "./view-types-combine.ts";
import { fileIdIncludes, makeResolveIncludes } from "./include-fold-core.ts";
import type {
  RawIncludeEntry,
  RawTypesDoc,
} from "../deterministic-shapes.ts";

export { fileIdIncludes };

const directiveOf = (includes: RawIncludeEntry[]): RawIncludeEntry | null =>
  includes.find((e) => e && e.datasource_types !== undefined) ?? null;

/**
 * Resolve a view_types document's `file:`/`id:` includes by folding each included
 * config in as the combine `source` (its views prepended) and the accumulator as
 * the `destination`. The `datasource_types` directive survives resolution and is
 * consumed later by `expandViewTypes`. A view `id:`/`file:` include carries the
 * referenced deterministic's datasource (`load` returns `datasourceText`), folded
 * in and returned as `datasourceYaml`; the merged datasource is what the combined
 * views' `inherits`/references validate against. Combine collisions / invalid
 * references throw.
 */
export const resolveViewIncludes = makeResolveIncludes({
  directiveOf,
  combine: ({ childYaml, accYaml, include, accDatasourceYaml }) =>
    combineViewTypes(childYaml, accYaml, {
      ...(include.combine_options ?? {}),
      datasourceData: accDatasourceYaml
        ? (parse(accDatasourceYaml) as RawTypesDoc)
        : null,
    }),
});
