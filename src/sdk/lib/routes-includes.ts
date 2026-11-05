import { combineRoutes } from "./routes-combine.ts";
import { makeFlatIncludeResolver } from "./include-fold-core.ts";

/**
 * Resolve a routes document's `file:`/`id:` includes by folding each included
 * config in as the combine `source` (its routes prepended) and the accumulator as
 * the `destination`. The `view_type_routes` directive (filter + eager paths)
 * survives resolution and is consumed later by route expansion. A routes `id:`
 * include carries the referenced deterministic's datasource (`load` returns
 * `datasourceText`), folded in and returned as `datasourceYaml`. Combine
 * collisions / unresolved `remove_routes` targets throw.
 */
export const resolveRoutesIncludes = makeFlatIncludeResolver(
  "view_type_routes",
  combineRoutes,
);
