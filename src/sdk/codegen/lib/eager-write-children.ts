// why mjs duplicate of parseCrudRouteSpecs.ts: Rust codegen (mjs) needs the eager-write child shape and cannot import the .ts loader without a build step.

import { routeViewTypeDirective } from "../../view-expand.ts";
import type { RawTypesDoc } from "../../deterministic-shapes.ts";

type TypeDef = Record<string, unknown>;

interface FieldValue {
  type?: unknown;
  references?: unknown;
}

type FieldEntry = [string, FieldValue];

interface TypesContainer {
  types?: unknown[];
}

interface TypeMaps {
  viewTypes: Map<string, TypeDef>;
  datasourceTypes: Map<string, TypeDef>;
}

interface ParsedLink {
  elementType: string;
  refTable: string;
  refColumn: string;
}

interface ChildSpecBase {
  fieldName: string;
  childTable: string;
  childColumns: string[];
  children?: ChildSpec[];
}

interface DirectFkChild extends ChildSpecBase {
  kind: "direct-fk";
  fkColumn: string;
}

interface M2mChild extends ChildSpecBase {
  kind: "m2m";
  junctionTable: string;
  parentFkColumn: string;
  targetFkColumn: string;
}

type ChildSpec = DirectFkChild | M2mChild;

type ChildrenByParent = Map<string, Map<string, ChildSpec>>;

interface EagerWriteDocs {
  datasourceData?: TypesContainer | null;
  routesData?: unknown;
  viewData?: TypesContainer | null;
}

function extractTypeMap(
  data: TypesContainer | null | undefined,
): Map<string, TypeDef> {
  const out = new Map<string, TypeDef>();
  for (const entry of data?.types ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const [name, def] = Object.entries(entry)[0] ?? [];
    if (typeof name === "string") out.set(name, (def ?? {}) as TypeDef);
  }
  return out;
}

function extractFieldEntries(def: TypeDef | undefined): FieldEntry[] {
  const fields = Array.isArray(def?.fields) ? def.fields : [];
  return fields
    .map((entry): FieldEntry | null => {
      if (!entry || typeof entry !== "object") return null;
      const pair = Object.entries(entry)[0];
      if (!pair) return null;
      return pair as FieldEntry;
    })
    .filter((p): p is FieldEntry => p !== null);
}

function parseChildLink(
  parentView: TypeDef,
  childFieldName: string,
): ParsedLink | null {
  const fields = extractFieldEntries(parentView);
  const found = fields.find(([name]) => name === childFieldName);
  if (!found) return null;
  const [, fdef] = found;
  const fieldType = typeof fdef?.type === "string" ? fdef.type : "";
  const references =
    typeof fdef?.references === "string" ? fdef.references : "";
  const elementMatch = fieldType.match(/^datasource_types\.(\w+)\[\]$/);
  if (!elementMatch) return null;
  const refMatch = references.match(/^datasource_types\.(\w+)\.(\w+)$/);
  if (!refMatch) return null;
  return {
    elementType: elementMatch[1],
    refTable: refMatch[1],
    refColumn: refMatch[2],
  };
}

function buildDirectFkChild(
  childFieldName: string,
  link: ParsedLink,
  maps: TypeMaps,
): ChildSpec | null {
  const childDef = maps.datasourceTypes.get(link.elementType);
  if (!childDef) return null;
  const childColumns = extractFieldEntries(childDef)
    .map(([name]) => name)
    .filter((name) => name !== link.refColumn);
  return {
    kind: "direct-fk",
    fieldName: childFieldName,
    childTable: link.elementType,
    fkColumn: link.refColumn,
    childColumns,
  };
}

function buildM2mChild(
  childFieldName: string,
  link: ParsedLink,
  maps: TypeMaps,
): ChildSpec | null {
  const { elementType, refTable, refColumn } = link;
  const junctionDef = maps.datasourceTypes.get(refTable);
  if (!junctionDef) return null;
  if (junctionDef.datasource_type !== "many-to-many") return null;
  const junctionFields = extractFieldEntries(junctionDef);
  const targetFkEntry = junctionFields.find(([name, f]) => {
    if (name === refColumn) return false;
    if (typeof f?.references !== "string") return false;
    const [refT] = f.references.split(".");
    return refT === elementType;
  });
  if (!targetFkEntry) return null;
  const targetDef = maps.datasourceTypes.get(elementType);
  if (!targetDef) return null;
  const targetColumns = extractFieldEntries(targetDef).map(([n]) => n);
  return {
    kind: "m2m",
    fieldName: childFieldName,
    childTable: elementType,
    junctionTable: refTable,
    parentFkColumn: refColumn,
    targetFkColumn: targetFkEntry[0],
    childColumns: targetColumns,
  };
}

function buildOneChild(
  parentViewName: string,
  childFieldName: string,
  maps: TypeMaps,
): ChildSpec | null {
  const parentView = maps.viewTypes.get(parentViewName);
  if (!parentView) return null;
  const link = parseChildLink(parentView, childFieldName);
  if (!link) return null;
  if (link.refTable === link.elementType) {
    return buildDirectFkChild(childFieldName, link, maps);
  }
  return buildM2mChild(childFieldName, link, maps);
}

/** Build the parent→children spec map by walking each eager_write_path parent, stopping a branch at the first child table that can't be built. */
function buildEagerWriteChildrenMap({
  parentPaths,
  viewTypes,
  datasourceTypes,
}: {
  parentPaths: string[];
  viewTypes: Map<string, TypeDef>;
  datasourceTypes: Map<string, TypeDef>;
}): ChildrenByParent {
  const maps: TypeMaps = { viewTypes, datasourceTypes };
  const childrenByParent: ChildrenByParent = new Map();
  for (const path of parentPaths) {
    const segments = path.split(".");
    let currentParent = segments[0];
    for (let i = 1; i < segments.length; i++) {
      const fieldName = segments[i];
      if (!childrenByParent.has(currentParent)) {
        childrenByParent.set(currentParent, new Map());
      }
      const bucket = childrenByParent.get(currentParent)!;
      let spec = bucket.get(fieldName);
      if (!spec) {
        const built = buildOneChild(currentParent, fieldName, maps);
        if (!built) break;
        spec = built;
        bucket.set(fieldName, spec);
      }
      currentParent = spec.childTable;
    }
  }
  return childrenByParent;
}

/** Recursively materialize the nested `children` arrays for one view from the flat parent→children map (keys sorted for deterministic output). */
function attachEagerWriteChildren(
  viewName: string,
  childrenByParent: ChildrenByParent,
): ChildSpec[] | undefined {
  const bucket = childrenByParent.get(viewName);
  if (!bucket || bucket.size === 0) return undefined;
  const out: ChildSpec[] = [];
  for (const key of [...bucket.keys()].sort()) {
    const spec = bucket.get(key)!;
    const nested = attachEagerWriteChildren(spec.childTable, childrenByParent);
    if (nested && nested.length > 0) spec.children = nested;
    out.push(spec);
  }
  return out;
}

/** The eager-write child specs rooted at `entityName`. `docs` = { datasourceData, routesData, viewData } (mirrors parseCrudRouteSpecs.ts's extractEagerWriteChildren). */
export function extractEagerWriteChildren(
  entityName: string,
  docs: EagerWriteDocs,
): ChildSpec[] {
  const { datasourceData, routesData, viewData } = docs;
  const paths: unknown = routeViewTypeDirective(
    routesData as RawTypesDoc | null,
  )?.eager_write_path;
  if (!Array.isArray(paths)) return [];
  const parentPaths = paths.filter(
    (p): p is string =>
      typeof p === "string" &&
      p.split(".").length >= 2 &&
      p.split(".")[0] === entityName,
  );
  if (parentPaths.length === 0) return [];
  const childrenByParent = buildEagerWriteChildrenMap({
    parentPaths,
    viewTypes: extractTypeMap(viewData),
    datasourceTypes: extractTypeMap(datasourceData),
  });
  return attachEagerWriteChildren(entityName, childrenByParent) ?? [];
}

/** The transitive eager-write child closure keyed by table, BFS from `rootName`. `docs` as in `extractEagerWriteChildren`. */
export function buildEagerWriteChildrenClosure(
  rootName: string,
  docs: EagerWriteDocs,
): Record<string, ChildSpec[]> {
  const byTable: Record<string, ChildSpec[]> = {};
  const queue = [rootName];
  while (queue.length > 0) {
    const table = queue.shift()!;
    if (Object.hasOwn(byTable, table)) continue;
    const children = extractEagerWriteChildren(table, docs);
    byTable[table] = children;
    for (const c of children) queue.push(c.childTable);
  }
  return byTable;
}
