import { combineServices } from "./services-combine.ts";
import { makeFlatIncludeResolver } from "./include-fold-core.ts";

/**
 * Resolve a services document's `file:`/`id:` includes by folding each included
 * config in as the combine `source` (its services prepended) and the accumulator
 * as the `destination`. The `view_type_services` directive survives resolution
 * and is consumed later by services expansion. A services `id:` include carries
 * the referenced deterministic's datasource (`load` returns `datasourceText`),
 * folded in and returned as `datasourceYaml` so generate generates the repositories
 * the merged services' `repo` args depend on. Combine collisions / unresolved
 * `remove_services` targets throw.
 */
export const resolveServicesIncludes = makeFlatIncludeResolver(
  "view_type_services",
  combineServices,
);
