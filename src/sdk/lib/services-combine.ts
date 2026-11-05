import { makeFlatCombine } from "./types-combine-core.ts";

const flat = makeFlatCombine({
  arrayKey: "services",
  nameOf: (entry) => (entry as { name: string })?.name,
  removeKey: "remove_services",
  label: "services",
});

/**
 * Apply a side's transform to a parsed services document → `{ services, unknownTargets }`.
 * Pure (deep-cloned). Services are flat entries, so the only op is `remove_services`.
 */
export const applyServiceSideOptions = flat.applySide;

/** Merge report (duplicate service names, unresolved `remove_services` targets) without asserting. */
export const reportCombineServices = flat.report;

/**
 * Combine two services.yaml documents: apply each side's `remove_services`,
 * concatenate source-then-destination services, and throw on a name collision or
 * an unresolved remove target. Only the merged `services:` are generated (the
 * resolver owns `includes:`); the included datasource is folded by the resolver.
 */
export const combineServices = flat.combine;
