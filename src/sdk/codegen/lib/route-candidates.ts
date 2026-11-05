import type { Enrichment } from "../../view-expand.ts";

interface DatasourceParent {
  datasource_type?: unknown;
  target?: unknown;
  [key: string]: unknown;
}

type DatasourceByName = Map<string, DatasourceParent>;

interface Inheritance {
  inheritsNamespace: string;
  datasourceType: string;
  target: string | null;
  parentName: string | null;
  parent: DatasourceParent | null | undefined;
}

interface ViewTypeDef {
  inherits?: unknown;
  __enrichments?: unknown;
}

interface ExpandedViewData {
  types?: Record<string, ViewTypeDef>[];
}

type Enrich<T> = (arg: {
  parentName: string | null;
  parent: DatasourceParent | null | undefined;
}) => T;

/** The fields `buildRouteCandidates` derives for every candidate before the caller's `enrich` payload is merged in. */
interface RouteCandidateBase {
  name: string;
  kind: string;
  inheritsNamespace: string;
  datasourceType: string;
  enrichments: Enrichment[];
  target: string | null;
}

/** Resolve `datasource_types.<x>` inheritance for a view/service candidate. */
function resolveInheritance(
  def: ViewTypeDef,
  datasourceByName: DatasourceByName,
): Inheritance {
  const inherits = typeof def.inherits === "string" ? def.inherits : "";
  if (!inherits.startsWith("datasource_types.")) {
    return {
      inheritsNamespace: "",
      datasourceType: "",
      target: null,
      parentName: null,
      parent: null,
    };
  }
  const parentName = inherits.slice("datasource_types.".length);
  const parent = datasourceByName.get(parentName);
  const datasourceType =
    parent && typeof parent.datasource_type === "string"
      ? parent.datasource_type
      : "";
  const target = typeof parent?.target === "string" ? parent.target : null;
  return {
    inheritsNamespace: "datasource_types",
    datasourceType,
    target,
    parentName,
    parent,
  };
}

/** Build the route/service candidate list from expanded view types. The shared skeleton (skip create_/update_, parse datasource_types inheritance, derive kind/enrichments) is identical across generators; each caller supplies `enrich` to add its own per-parent fields (primary key, field summaries). */
export function buildRouteCandidates<T>(
  expandedViewData: ExpandedViewData,
  datasourceByName: DatasourceByName,
  enrich: Enrich<T>,
): Array<RouteCandidateBase & T> {
  const out: Array<RouteCandidateBase & T> = [];
  for (const entry of expandedViewData.types ?? []) {
    const [name, def] = Object.entries(entry)[0];
    if (name.startsWith("update_")) continue;
    if (name.startsWith("create_")) continue;
    const { inheritsNamespace, datasourceType, target, parentName, parent } =
      resolveInheritance(def, datasourceByName);
    const kind =
      inheritsNamespace === "datasource_types"
        ? "datasource_type"
        : "view_type";
    const enrichments: Enrichment[] = Array.isArray(def.__enrichments)
      ? def.__enrichments
      : [];
    out.push({
      name,
      kind,
      inheritsNamespace,
      datasourceType,
      enrichments,
      target,
      ...enrich({ parentName, parent }),
    } as RouteCandidateBase & T);
  }
  return out;
}
