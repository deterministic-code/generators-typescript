import { expandViewTypes } from "../view-expand.ts";
import { snakeToPascal } from "../case.ts";
import { compileFilter, type FilterPredicate } from "./compile-filter.ts";
import type { RawTypesDoc } from "../deterministic-shapes.ts";

/** A custom service entry as authored in a services doc's `services:` list. */
interface RawServiceEntry {
  name: string;
}

/** The `view_type_services` selector directive from a services doc's `includes:` list. */
interface ServiceDirective {
  filter?: string;
}

interface ServiceIncludeEntry {
  view_type_services?: ServiceDirective;
}

/** A parsed services doc: authored `services:` entries plus `includes:` directives. */
export interface ServicesDoc {
  services?: RawServiceEntry[];
  includes?: ServiceIncludeEntry[];
}

/** A datasource-type or view-type candidate a `view_type_services` filter is applied to. */
interface ServiceCandidate {
  name: string;
  kind: string;
  inheritsNamespace: string;
  datasourceType: string | null;
  hasUpdateVariant?: boolean;
}

interface GeneratedServiceEntry {
  name: string;
  type: string;
  description: string;
  entity: string;
  isCustom: boolean;
}

type ExplicitServiceEntry = RawServiceEntry & {
  entity: null;
  isCustom: boolean;
};
type ServiceEntry = ExplicitServiceEntry | GeneratedServiceEntry;

export function compileServicesFilter(
  filterExpr: string | null | undefined,
): FilterPredicate {
  return compileFilter(filterExpr, {
    contextLabel: "view_type_services.filter",
  });
}

export function buildCandidates(
  expandedViewData: RawTypesDoc,
  datasourceData: RawTypesDoc,
): ServiceCandidate[] {
  const byName = new Map<string, ServiceCandidate>();
  const dsMap = new Map<string, string | null>();
  const expandedNames = new Set(
    (expandedViewData?.types ?? []).map((entry) => Object.keys(entry)[0]),
  );

  for (const entry of datasourceData?.types ?? []) {
    const [name, def] = Object.entries(entry)[0];
    const datasourceType = def?.datasource_type ?? null;
    dsMap.set(name, datasourceType);
    byName.set(name, {
      name,
      kind: "datasource_type",
      inheritsNamespace: "",
      datasourceType,
    });
  }

  for (const entry of expandedViewData?.types ?? []) {
    const [name, def] = Object.entries(entry)[0];
    if (name.startsWith("update_")) continue;
    if (name.startsWith("create_")) continue;
    const inherits =
      def && typeof def.inherits === "string" ? def.inherits : "";
    const inheritsNamespace = inherits.startsWith("datasource_types.")
      ? "datasource_types"
      : "";
    const datasourceType = inherits.startsWith("datasource_types.")
      ? (dsMap.get(inherits.slice("datasource_types.".length)) ?? null)
      : null;
    const hasUpdateVariant = expandedNames.has(`update_${name}`);
    byName.set(name, {
      name,
      kind: "view_type",
      inheritsNamespace,
      datasourceType,
      hasUpdateVariant,
    });
  }

  return [...byName.values()];
}

function autoCrudServiceEntry(entityName: string): GeneratedServiceEntry {
  const className = `${snakeToPascal(entityName)}Service`;
  return {
    name: className,
    type: `services/${className}`,
    description: `Auto-generated CRUD service for entity '${entityName}'.`,
    entity: entityName,
    isCustom: false,
  };
}

/** Filter-matched, name-sorted service candidates for a `view_type_services` block. */
export function serviceCandidateSurvivors({
  block,
  viewData,
  datasourceData,
  expandOptions,
}: {
  block: ServiceDirective;
  viewData: RawTypesDoc;
  datasourceData: RawTypesDoc;
  expandOptions?: { mode?: string };
}): ServiceCandidate[] {
  const expandedView = expandViewTypes(viewData, datasourceData, expandOptions);
  const candidates = buildCandidates(expandedView, datasourceData);
  const predicate = compileServicesFilter(block.filter);
  const survivors = candidates.filter(predicate);
  survivors.sort((a, b) => a.name.localeCompare(b.name));
  return survivors;
}

/** The `view_type_services` selector directive, read from the top-level `includes:` list (`null` when absent). */
export function serviceViewTypeDirective(
  servicesData: ServicesDoc,
): ServiceDirective | null {
  const includes = Array.isArray(servicesData?.includes)
    ? servicesData.includes
    : [];
  return (
    includes.find((e) => e && e.view_type_services !== undefined)
      ?.view_type_services ?? null
  );
}

export function expandServices({
  servicesData,
  viewData,
  datasourceData,
}: {
  servicesData: ServicesDoc;
  viewData: RawTypesDoc;
  datasourceData: RawTypesDoc;
}): { services: ServiceEntry[] } {
  const explicit: ExplicitServiceEntry[] = (
    Array.isArray(servicesData.services) ? servicesData.services : []
  ).map((s) => ({ ...s, entity: null, isCustom: true }));

  const block = serviceViewTypeDirective(servicesData);
  if (!block) return { services: explicit };

  const explicitNames = new Set(explicit.map((s) => s.name));
  const survivors = serviceCandidateSurvivors({
    block,
    viewData,
    datasourceData,
  });

  const generated: GeneratedServiceEntry[] = [];
  for (const cand of survivors) {
    const entry = autoCrudServiceEntry(cand.name);
    if (explicitNames.has(entry.name)) continue;
    generated.push(entry);
  }

  return { services: [...explicit, ...generated] };
}
