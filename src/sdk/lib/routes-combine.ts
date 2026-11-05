import { makeFlatCombine } from "./types-combine-core.ts";

/** A route entry is either a string shorthand or a single-key `{ name: def }` object. */
const routeNameOf = (entry: unknown): string =>
  typeof entry === "string" ? entry : Object.keys(entry as object)[0];

const flat = makeFlatCombine({
  arrayKey: "routes",
  nameOf: routeNameOf,
  removeKey: "remove_routes",
  label: "routes",
});

/**
 * Apply a side's transform to a parsed routes document → `{ routes, unknownTargets }`.
 * Pure (deep-cloned). Routes are flat entries (string | `{ name: def }`), so the
 * only op is `remove_routes` (drop a whole route by name).
 */
export const applyRouteSideOptions = flat.applySide;

/** Merge report (duplicate route names, unresolved `remove_routes` targets) without asserting. */
export const reportCombineRoutes = flat.report;

/**
 * Combine two routes.yaml documents: apply each side's `remove_routes`,
 * concatenate source-then-destination routes, and throw on a name collision or an
 * unresolved remove target. Only the merged `routes:` are generated — the
 * `view_type_routes` directive and `combined_routes:` stay with the destination
 * (the resolver owns `includes:`); the included datasource is folded by the resolver.
 */
export const combineRoutes = flat.combine;
