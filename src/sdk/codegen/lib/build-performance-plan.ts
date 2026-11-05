import { topoSortEntities } from "../../lib/entity-topo-sort.ts";
import { entityUsesOptimisticConcurrency } from "../../lib/generate-sql.ts";
import { indexDatasourceByName as indexDatasource } from "../../lib/datasource-index.ts";
import { compileRoutesFilter } from "../../lib/compile-filter.ts";
import { kebabPlural } from "../../case.ts";
import { routeViewTypeDirective } from "../../view-expand.ts";
import { layoutFor } from "./ts-codegen-naming.ts";
import { SAMPLE_BINARY_BASE64 } from "./ts-sample-literal.ts";
import type {
  RawTypesDoc,
  RawTypeDef,
  RawFieldDef,
  RouteViewTypeDirective,
} from "../../deterministic-shapes.ts";
import type { JsonValue } from "../../read-settings.ts";

const layout = layoutFor({});

type EntityKind = "m2m" | "readonly" | "no_pk" | "regular";

/** A datasource field def as the perf planner reads it — the shared `RawFieldDef` plus the authored `default_value` a create body may need to skip. */
interface PerfFieldDef extends RawFieldDef {
  default_value?: JsonValue;
}
type PerfFieldEntry = Record<string, PerfFieldDef>;

/** A datasource type def as the perf planner reads it — `RawTypeDef` plus the `target`/`seeds`/`skip_migrations` markers the plan branches on. */
export interface PerfTypeDef extends RawTypeDef {
  target?: string;
  seeds?: JsonValue[];
  skip_migrations?: boolean;
  use_optimistic_concurrency?: boolean;
  fields?: PerfFieldEntry[];
}
type PerfTypeEntry = Record<string, PerfTypeDef>;

/** The parsed `datasource_types` doc the plan is built from — the ordered `types` list of single-key entries. */
export interface PerfDatasourceDoc {
  types?: PerfTypeEntry[];
}

/** Options authored under a parent's `combined_types` child entry — an explicit route, and the m2m `via`/`target` link when present. */
interface CombinedChildOpts {
  route?: string;
  via?: string;
  target?: string;
}
type CombinedTypeEntry = string | Record<string, CombinedChildOpts>;
interface CombinedRouteDef {
  route?: string;
  combined_types?: CombinedTypeEntry[];
}
type CombinedRouteEntry = Record<string, CombinedRouteDef>;

/** The parsed routes doc — `RawTypesDoc` plus the `combined_routes` block whose nested-child structure the plan walks. */
export interface RoutesDoc extends RawTypesDoc {
  combined_routes?: CombinedRouteEntry[];
}

/** The `view_type_routes` directive as the plan reads it — `RouteViewTypeDirective` plus the route `filter` expression, with the eager path lists narrowed to JSON values the validator checks at the boundary. */
interface PerfRouteDirective extends RouteViewTypeDirective {
  filter?: string;
  eager_path?: JsonValue[];
  eager_write_path?: JsonValue[];
}

type PerfPhase = "lookup" | "iter" | "iter_teardown";
type WriteOp = "POST" | "PUT" | "PATCH";
type MutationOp = WriteOp | "DELETE";
type PerfOp = "GET" | MutationOp;
type CaptureMap = Record<string, string>;

type TemplateScalar = string | number | boolean;

/** A request-body template — scalar placeholders per field, or an array of nested child bodies for an eager-write embed. */
interface TemplateBody {
  [key: string]: TemplateScalar | TemplateBody[];
}

/** One plan step — the HTTP op against `path`, with an optional write `body`, OCC `if_match` token, and JSONPath `capture` map (which of these are present depends on `op` and whether OCC is on). */
interface PerfStep {
  id: string;
  phase: PerfPhase;
  op: PerfOp;
  path: string;
  body?: TemplateBody;
  if_match?: string;
  capture?: CaptureMap;
}

/** The generated plan — the per-iteration template variables plus the ordered step list. */
interface PerformancePlan {
  iteration_template_vars: string[];
  steps: PerfStep[];
}

/** A resolved FK column that references a seeded readonly-lookup parent by a synthesized `<fk>_name` column. */
interface EnrichedFk {
  field: string;
  parent: string;
  parentKind: "readonly";
  enriched: true;
  newField: string;
  refKey: string;
}

/** A resolved FK column referenced by its own name — either a regular parent (`ids` pool) or a readonly-lookup captured by `refKey`. */
interface PlainFk {
  field: string;
  parent: string;
  parentKind: EntityKind;
  enriched: false;
  newField: null;
  refKey: string | null;
}

type FkField = EnrichedFk | PlainFk;

/** A node in the eager-write path tree — its named children, each a nested embed. */
interface EagerNode {
  children: Map<string, EagerNode>;
}

/** The resolved element entity behind an eager-write child field — its name, datasource def, and whether the link is many-to-many. */
interface ElementInfo {
  name: string;
  def: PerfTypeDef;
  m2m: boolean;
}

interface DirectFkMeta {
  parent: string;
  parentBase: string;
  route: string;
}

interface M2mLink {
  parent: string;
  parentBase: string;
  target: string;
  via: string;
  route: string;
}

/** The shared write-body arguments — the entity name, its def, and its resolved FK fields. */
interface BodyArgs {
  entityName: string;
  typeDef: PerfTypeDef;
  fkFields: FkField[];
}

/** The routing/eager graph a regular entity's step builders consult. */
interface GraphInputs {
  directFk: Map<string, DirectFkMeta>;
  eagerReadRoots: Set<string>;
  eagerWriteByRoot: Map<string, EagerNode>;
  viewByName: Map<string, RawTypeDef>;
}

/** The shared arguments for a CRUD step lane — the entity, its resolved FKs and PK column, the step accumulators, and the OCC flag. */
interface CrudLaneArgs {
  name: string;
  def: PerfTypeDef;
  fks: FkField[];
  pkCol: string;
  iterSteps: PerfStep[];
  teardownSteps: PerfStep[];
  occ?: boolean;
}

/** The shared arguments for resolving/walking an eager-write child field. */
interface EagerChildArgs {
  viewByName: Map<string, RawTypeDef>;
  datasourceByName: Map<string, PerfTypeDef>;
  knownSet: Set<string>;
  mode: string;
}

type ExcludeEntityFn = (name: string, def: PerfTypeDef | undefined) => boolean;

/** The resolved inputs the lookup and iter phases consume. */
interface PerfPlanInputs {
  byName: Map<string, PerfTypeDef>;
  known: Set<string>;
  directFk: Map<string, DirectFkMeta>;
  m2m: M2mLink[];
  viewByName: Map<string, RawTypeDef>;
  eagerReadRoots: Set<string>;
  eagerWriteByRoot: Map<string, EagerNode>;
  isExcluded: (name: string) => boolean;
}

function fieldsOf(typeDef?: PerfTypeDef | null): PerfFieldEntry[] {
  const fields = typeDef?.fields;
  return Array.isArray(fields) ? fields : [];
}

function classifyEntity(typeDef?: PerfTypeDef | null): EntityKind {
  if (typeDef?.datasource_type === "many-to-many") return "m2m";
  if (typeDef?.datasource_type === "readonly-lookup") return "readonly";
  if (typeDef?.target === "None") return "no_pk";
  return "regular";
}

function primaryKeyColumn(typeDef?: PerfTypeDef | null): string {
  for (const entry of fieldsOf(typeDef)) {
    const [fname, fdef] = Object.entries(entry)[0] ?? [];
    if (
      typeof fname === "string" &&
      fname !== "id" &&
      fdef &&
      typeof fdef === "object" &&
      fdef.primary_key === true
    ) {
      return fname;
    }
  }
  return "id";
}

export function isRustUnsupportedSkipMigrations(
  _name: string,
  _def?: PerfTypeDef | null,
): boolean {
  return false;
}

// Predicate retained for legacy callers; --exclude-skip-migrations is unused since both perf paths run the full migration chain via createBackendApp()/main.rs bootstrap.
export function isSkipMigrationsEntity(
  _name: string,
  def?: PerfTypeDef | null,
): boolean {
  return def?.skip_migrations === true;
}

// String-PK readonly-lookups have no meaningful first_id; dependents reference first_name instead.
function lookupRefKey(parentDef?: PerfTypeDef | null): string {
  return primaryKeyColumn(parentDef) === "id" ? "first_id" : "first_name";
}

function makeFkField(
  field: string,
  parent: string,
  parentDef?: PerfTypeDef | null,
): FkField {
  const parentKind = classifyEntity(parentDef);
  if (parentKind === "readonly" && field.endsWith("_id")) {
    return {
      field,
      parent,
      parentKind: "readonly",
      enriched: true,
      newField: `${field.slice(0, -"_id".length)}_name`,
      refKey: lookupRefKey(parentDef),
    };
  }
  const refKey = parentKind === "readonly" ? lookupRefKey(parentDef) : null;
  return { field, parent, parentKind, enriched: false, newField: null, refKey };
}

function findFkFields(
  typeDef: PerfTypeDef | null | undefined,
  known: Set<string>,
  byName: Map<string, PerfTypeDef>,
): FkField[] {
  const fks: FkField[] = [];
  for (const entry of fieldsOf(typeDef)) {
    const [fname, fdef] = Object.entries(entry)[0];
    if (!fdef || typeof fdef.references !== "string") continue;
    const parent = fdef.references.split(".")[0];
    if (!known.has(parent)) continue;
    fks.push(makeFkField(fname, parent, byName.get(parent)));
  }
  return fks;
}

function indexFksByField(fks: FkField[]): Map<string, FkField> {
  return new Map(fks.map((f): [string, FkField] => [f.field, f]));
}

function indexEnrichedFksByNewField(fks: FkField[]): Map<string, EnrichedFk> {
  return new Map(
    fks
      .filter((f): f is EnrichedFk => f.enriched)
      .map((f): [string, EnrichedFk] => [f.newField, f]),
  );
}

function parseCombinedChild(childEntry: CombinedTypeEntry): {
  childName: string;
  opts: CombinedChildOpts;
} {
  if (typeof childEntry === "string") {
    return { childName: childEntry.replace(/-/g, "_"), opts: {} };
  }
  const [rawChild, rawOpts] = Object.entries(childEntry)[0];
  return { childName: rawChild.replace(/-/g, "_"), opts: rawOpts ?? {} };
}

function collectCombinedChildren(routesData: RoutesDoc): {
  directFk: Map<string, DirectFkMeta>;
  m2m: M2mLink[];
} {
  const directFk = new Map<string, DirectFkMeta>();
  const m2m: M2mLink[] = [];
  for (const parentEntry of routesData.combined_routes ?? []) {
    const [rawParent, parentDef] = Object.entries(parentEntry)[0];
    const parent = rawParent.replace(/-/g, "_");
    const parentRoute =
      parentDef?.route ?? `/api/${layout.apiPath(parent)}/{id}`;
    const parentBase = parentRoute.replace(/\/?\{[^}]+\}$/, "");
    for (const childEntry of parentDef?.combined_types ?? []) {
      const { childName, opts } = parseCombinedChild(childEntry);
      const route = opts.route ?? `/${layout.apiPath(childName)}`;
      if (opts.via && opts.target) {
        m2m.push({
          parent,
          parentBase,
          target: opts.target.replace(/-/g, "_"),
          via: opts.via.replace(/-/g, "_"),
          route,
        });
      } else {
        directFk.set(childName, { parent, parentBase, route });
      }
    }
  }
  return { directFk, m2m };
}

// randSuffix() renders to 15 chars today; reserve 16 to absorb Date.now() rollover to 9 chars in 2059.
const RAND_SUFFIX_RESERVE = 16;

export function stringTemplateValue({
  opTag,
  entityName,
  fname,
  fdef,
}: {
  opTag: string;
  entityName: string;
  fname: string;
  fdef: { size?: number };
}): string {
  const prefix = `perf-${opTag}${entityName}-${fname}-`;
  const size = fdef.size;
  if (typeof size === "number" && size > 0) {
    const maxPrefix = size - RAND_SUFFIX_RESERVE;
    if (maxPrefix < prefix.length) {
      const truncated = maxPrefix > 0 ? prefix.slice(0, maxPrefix) : "";
      return `${truncated}\${randSuffix()}`;
    }
  }
  return `${prefix}\${randSuffix()}`;
}

// The [key, value] one field contributes to a template body, or null to omit it: FK columns reference the parent's captured id/lookup (or the enriched `<fk>_name`), a PATCH/PUT PK reuses the captured POST id, nullable/defaulted columns are skipped, and remaining scalars take a per-type placeholder.
function bodyFieldEntry({
  fname,
  fdef,
  fkByField,
  isUpdate,
  entityName,
  opTag,
}: {
  fname: string;
  fdef: PerfFieldDef;
  fkByField: Map<string, FkField>;
  isUpdate: boolean;
  entityName: string;
  opTag: string;
}): [string, TemplateScalar] | null {
  const fk = fkByField.get(fname);
  if (fk) {
    if (fk.enriched) {
      return [fk.newField, `\${lookups.${fk.parent}.first_name}`];
    }
    const value =
      fk.parentKind === "readonly"
        ? `\${lookups.${fk.parent}.${fk.refKey}}`
        : `\${ids.${fk.parent}[i]}`;
    return [fname, value];
  }
  // PATCH/PUT body PK must reuse the captured POST id; else the router 404s on key-mismatch.
  if (fdef.primary_key === true && isUpdate) {
    return [fname, `\${ids.${entityName}[i]}`];
  }
  const hasDefault =
    fdef.default_value !== undefined && fdef.default_value !== null;
  if (fdef.is_nullable === true || hasDefault) return null;
  const value = scalarBodyValue({ fdef, opTag, entityName, fname });
  return value === undefined ? null : [fname, value];
}

function templateBodyForEntity({
  entityName,
  typeDef,
  fkFields,
  opTag = "",
}: BodyArgs & { opTag?: string }): TemplateBody {
  const body: TemplateBody = {};
  const fkByField = indexFksByField(fkFields);
  const isUpdate = opTag === "patch-" || opTag === "upd-";
  for (const entry of fieldsOf(typeDef)) {
    const [fname, fdef] = Object.entries(entry)[0];
    const kv = bodyFieldEntry({
      fname,
      fdef,
      fkByField,
      isUpdate,
      entityName,
      opTag,
    });
    if (kv) body[kv[0]] = kv[1];
  }
  return body;
}

function patchBodyFor(args: BodyArgs): TemplateBody {
  return templateBodyForEntity({ ...args, opTag: "patch-" });
}

function putBodyFor(args: BodyArgs): TemplateBody {
  return templateBodyForEntity({ ...args, opTag: "upd-" });
}

function bodyForOp({
  op,
  entityName,
  typeDef,
  fkFields,
}: BodyArgs & { op: string }): TemplateBody {
  if (op === "PUT") return putBodyFor({ entityName, typeDef, fkFields });
  if (op === "PATCH") return patchBodyFor({ entityName, typeDef, fkFields });
  return templateBodyForEntity({ entityName, typeDef, fkFields });
}

// The placeholder body value for a plain (non-FK, non-PK) scalar field by type, or undefined for a type the perf plan does not populate. binary is carried as a base64 string on the wire (matching the OpenAPI `format: byte` sampler).
function scalarBodyValue({
  fdef,
  opTag,
  entityName,
  fname,
}: {
  fdef: PerfFieldDef;
  opTag: string;
  entityName: string;
  fname: string;
}): TemplateScalar | undefined {
  switch (fdef.type) {
    case "string":
      return stringTemplateValue({ opTag, entityName, fname, fdef });
    case "number":
    case "reference":
      return 1;
    case "boolean":
      return false;
    case "datetime":
      return "2024-01-01T00:00:00.000Z";
    case "binary":
      return SAMPLE_BINARY_BASE64;
    default:
      return undefined;
  }
}

function plural(name: string): string {
  return kebabPlural(name);
}

function indexViewTypes(
  viewTypesData?: RawTypesDoc | null,
): Map<string, RawTypeDef> {
  const byName = new Map<string, RawTypeDef>();
  for (const entry of viewTypesData?.types ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const [name, def] = Object.entries(entry)[0] ?? [];
    if (!name) continue;
    byName.set(name, def ?? {});
  }
  return byName;
}

function stripNamespacePrefix(qualifiedName: string): string {
  const parts = qualifiedName.split(".");
  return parts[parts.length - 1];
}

function elementTypeFromArrayDecl(typeDecl?: string): string | null {
  if (typeof typeDecl !== "string" || !typeDecl.endsWith("[]")) return null;
  return stripNamespacePrefix(typeDecl.slice(0, -2));
}

function referenceTableFromQualified(refStr?: string): string | null {
  if (typeof refStr !== "string") return null;
  const parts = refStr.split(".");
  if (parts.length < 2) return null;
  return parts[parts.length - 2];
}

function resolveElementFromField(
  fdef: RawFieldDef,
  datasourceByName: Map<string, PerfTypeDef>,
): ElementInfo | null {
  const elementType = elementTypeFromArrayDecl(fdef.type);
  if (!elementType) return null;
  const refTable = referenceTableFromQualified(fdef.references);
  if (!refTable) return null;
  const refDef = datasourceByName.get(refTable);
  if (!refDef) return null;
  if (refDef.datasource_type === "many-to-many") {
    const targetDef = datasourceByName.get(elementType);
    if (!targetDef) return null;
    return { name: elementType, def: targetDef, m2m: true };
  }
  return { name: elementType, def: refDef, m2m: false };
}

function eagerWriteChildElement({
  parent,
  childField,
  viewByName,
  datasourceByName,
}: {
  parent: string;
  childField: string;
  viewByName: Map<string, RawTypeDef>;
  datasourceByName: Map<string, PerfTypeDef>;
}): ElementInfo | null {
  const parentView = viewByName.get(parent);
  if (!parentView) return null;
  for (const entry of parentView.fields ?? []) {
    const [fname, fdef] = Object.entries(entry)[0] ?? [];
    if (fname !== childField) continue;
    if (!fdef) return null;
    return resolveElementFromField(fdef, datasourceByName);
  }
  return null;
}

function validateDottedPathEntries(
  rawList: JsonValue[] | null | undefined,
  kind: string,
): string[] {
  if (rawList === undefined || rawList === null) return [];
  if (!Array.isArray(rawList)) {
    throw new Error(
      `${kind} must be an array of dotted paths, got ${typeof rawList}`,
    );
  }
  const paths: string[] = [];
  for (const entry of rawList) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(
        `${kind} entries must be non-empty strings, got ${JSON.stringify(entry)}`,
      );
    }
    paths.push(entry);
  }
  return paths;
}

function parseEagerWritePathsByRoot(
  rawList: JsonValue[] | null | undefined,
): Map<string, EagerNode> {
  const out = new Map<string, EagerNode>();
  for (const entry of validateDottedPathEntries(rawList, "eager_write_path")) {
    const segments = entry.split(".");
    if (segments.length < 2 || segments.some((s) => s.length === 0)) {
      throw new Error(
        `eager_write_path entry "${entry}" must be dotted: parent.field[.grandchild]`,
      );
    }
    const [root, ...rest] = segments;
    let node = out.get(root);
    if (!node) {
      node = { children: new Map<string, EagerNode>() };
      out.set(root, node);
    }
    let cursor = node.children;
    for (const seg of rest) {
      let next = cursor.get(seg);
      if (!next) {
        next = { children: new Map<string, EagerNode>() };
        cursor.set(seg, next);
      }
      cursor = next.children;
    }
  }
  return out;
}

function parseEagerReadRoots(
  rawList: JsonValue[] | null | undefined,
): Set<string> {
  const roots = new Set<string>();
  for (const entry of validateDottedPathEntries(rawList, "eager_path")) {
    const root = entry.split(".")[0];
    if (root) roots.add(root);
  }
  return roots;
}

function buildEagerChildBody({
  elementName,
  elementDef,
  datasourceByName,
  knownSet,
  mode,
  parentName,
}: {
  elementName: string;
  elementDef: PerfTypeDef;
  datasourceByName: Map<string, PerfTypeDef>;
  knownSet: Set<string>;
  mode: string;
  parentName: string;
}): TemplateBody {
  const fks = findFkFields(elementDef, knownSet, datasourceByName);
  const args: BodyArgs = {
    entityName: elementName,
    typeDef: elementDef,
    fkFields: fks,
  };
  const base =
    mode === "PUT"
      ? putBodyFor(args)
      : mode === "PATCH"
        ? patchBodyFor(args)
        : templateBodyForEntity(args);
  const fkByField = indexFksByField(fks);
  const fkByNewField = indexEnrichedFksByNewField(fks);
  const out: TemplateBody = {};
  for (const [k, v] of Object.entries(base)) {
    const fk = fkByField.get(k) ?? fkByNewField.get(k);
    if (fk && fk.parent === parentName) continue;
    out[k] = v;
  }
  return out;
}

function buildNestedChildEntry({
  parent,
  childField,
  childNode,
  viewByName,
  datasourceByName,
  knownSet,
  mode,
}: EagerChildArgs & {
  parent: string;
  childField: string;
  childNode: EagerNode;
}): TemplateBody[] {
  const elementInfo = eagerWriteChildElement({
    parent,
    childField,
    viewByName,
    datasourceByName,
  });
  if (!elementInfo) {
    throw new Error(
      `eager_write_path "${parent}.${childField}" — could not resolve element entity from view_types.yaml`,
    );
  }
  if (elementInfo.m2m) {
    const targetFks = findFkFields(elementInfo.def, knownSet, datasourceByName);
    const targetBody = templateBodyForEntity({
      entityName: elementInfo.name,
      typeDef: elementInfo.def,
      fkFields: targetFks,
    });
    const fkByField = indexFksByField(targetFks);
    const fkByNewField = indexEnrichedFksByNewField(targetFks);
    for (const k of Object.keys(targetBody)) {
      const fk = fkByField.get(k) ?? fkByNewField.get(k);
      if (fk) delete targetBody[k];
    }
    return [targetBody];
  }
  const body = buildEagerChildBody({
    elementName: elementInfo.name,
    elementDef: elementInfo.def,
    datasourceByName,
    knownSet,
    mode,
    parentName: parent,
  });
  for (const [grandField, grandNode] of childNode.children) {
    body[grandField] = buildNestedChildEntry({
      parent: elementInfo.name,
      childField: grandField,
      childNode: grandNode,
      viewByName,
      datasourceByName,
      knownSet,
      mode,
    });
  }
  return [body];
}

function collectEagerWriteFkParents({
  root,
  rootNode,
  viewByName,
  datasourceByName,
  knownSet,
}: {
  root: string;
  rootNode: EagerNode;
  viewByName: Map<string, RawTypeDef>;
  datasourceByName: Map<string, PerfTypeDef>;
  knownSet: Set<string>;
}): Set<string> {
  const out = new Set<string>();
  if (!viewByName.has(root)) return out;
  const visit = (parentName: string, parentNode: EagerNode): void => {
    for (const [childField, childNode] of parentNode.children) {
      const elementInfo = eagerWriteChildElement({
        parent: parentName,
        childField,
        viewByName,
        datasourceByName,
      });
      if (!elementInfo) continue;
      const fks = findFkFields(elementInfo.def, knownSet, datasourceByName);
      for (const fk of fks) {
        if (fk.parent === root) continue;
        if (fk.parent === elementInfo.name) continue;
        if (fk.parentKind === "readonly") continue;
        out.add(fk.parent);
      }
      visit(elementInfo.name, childNode);
    }
  };
  visit(root, rootNode);
  return out;
}

function buildEagerWriteBody({
  parent,
  parentDef,
  parentNode,
  viewByName,
  datasourceByName,
  knownSet,
  mode,
}: {
  parent: string;
  parentDef: PerfTypeDef;
  parentNode: EagerNode;
  viewByName: Map<string, RawTypeDef>;
  datasourceByName: Map<string, PerfTypeDef>;
  knownSet: Set<string>;
  mode: string;
}): TemplateBody {
  const fks = findFkFields(parentDef, knownSet, datasourceByName);
  const parentBody = bodyForOp({
    op: mode,
    entityName: parent,
    typeDef: parentDef,
    fkFields: fks,
  });
  const out: TemplateBody = { ...parentBody };
  for (const [childField, childNode] of parentNode.children) {
    out[childField] = buildNestedChildEntry({
      parent,
      childField,
      childNode,
      viewByName,
      datasourceByName,
      knownSet,
      mode,
    });
  }
  return out;
}

function lookupSteps(name: string, def: PerfTypeDef): PerfStep[] {
  const collection = `/api/${layout.apiPath(name)}`;
  const pkCol = primaryKeyColumn(def);
  const hasNameField = fieldsOf(def).some(
    (entry) => Object.keys(entry)[0] === "name",
  );
  const refKey = lookupRefKey(def);
  const capture: CaptureMap = {
    [`lookups.${name}.ids`]: `$.items[*].${pkCol}`,
  };
  if (pkCol === "id") {
    capture[`lookups.${name}.first_id`] = `$.items[0].${pkCol}`;
  }
  if (hasNameField) {
    capture[`lookups.${name}.first_name`] = "$.items[0].name";
  }
  if (refKey === "first_name" && !hasNameField) {
    throw new Error(
      `buildPerformancePlan: readonly-lookup "${name}" has non-id PK "${pkCol}" but no "name" field; perf-client supports only first_id (numeric PK "id") or first_name (string PK with "name" field)`,
    );
  }
  const out: PerfStep[] = [
    {
      id: `lookup-${plural(name)}`,
      phase: "lookup",
      op: "GET",
      path: collection,
      capture,
    },
  ];
  if (Array.isArray(def.seeds) && def.seeds.length > 0) {
    out.push({
      id: `lookup-${name.replace(/_/g, "-")}-by-id`,
      phase: "lookup",
      op: "GET",
      path: `${collection}/\${lookups.${name}.${refKey}}`,
    });
  }
  return out;
}

function m2mLinkSteps(link: M2mLink): PerfStep[] {
  const targetDash = link.target.replace(/_/g, "-");
  const parentDash = link.parent.replace(/_/g, "-");
  const linkBase = `${link.parentBase}/\${ids.${link.parent}[i]}${link.route}`;
  const linkMember = `${linkBase}/\${ids.${link.target}[i]}`;
  return [
    {
      id: `link-${targetDash}-to-${parentDash}`,
      phase: "iter",
      op: "POST",
      path: linkBase,
      body: { [`${link.target}_id`]: `\${ids.${link.target}[i]}` },
    },
    {
      id: `link-${targetDash}-to-${parentDash}-by-id`,
      phase: "iter",
      op: "POST",
      path: linkMember,
    },
    {
      id: `get-${parentDash}-${plural(link.target)}-list`,
      phase: "iter",
      op: "GET",
      path: linkBase,
    },
    {
      id: `get-${parentDash}-${targetDash}-by-id`,
      phase: "iter",
      op: "GET",
      path: linkMember,
    },
    {
      id: `unlink-${targetDash}-from-${parentDash}`,
      phase: "iter",
      op: "DELETE",
      path: linkMember,
    },
  ];
}

function nestedFkSteps({
  name,
  def,
  fks,
  pkCol,
  meta,
  iterSteps,
  teardownSteps,
  occ = false,
}: CrudLaneArgs & { meta: DirectFkMeta }): void {
  const nestedBase = `${meta.parentBase}/\${ids.${meta.parent}[i]}${meta.route}`;
  const nestedMember = `${nestedBase}/\${ids.${name}[i]}`;
  const dashName = name.replace(/_/g, "-");
  const nestedFks = fks.filter((f) => f.parent !== meta.parent);
  const nestedBody = (op: string): TemplateBody =>
    bodyForOp({ op, entityName: name, typeDef: def, fkFields: nestedFks });
  iterSteps.push({
    id: `post-${dashName}-nested`,
    phase: "iter",
    op: "POST",
    path: nestedBase,
    body: nestedBody("POST"),
    capture: {
      [`ids.${name}[i]`]: `$.${pkCol}`,
      ...versionCaptureFor(name, occ),
    },
  });
  iterSteps.push({
    id: `get-${plural(name)}-nested`,
    phase: "iter",
    op: "GET",
    path: nestedBase,
  });
  iterSteps.push(
    mutationStep({
      id: `put-${dashName}-nested`,
      phase: "iter",
      op: "PUT",
      path: nestedMember,
      body: nestedBody("PUT"),
      pool: name,
      occ,
    }),
  );
  teardownSteps.push(
    mutationStep({
      id: `delete-${dashName}-nested`,
      phase: "iter_teardown",
      op: "DELETE",
      path: nestedMember,
      pool: name,
      occ,
    }),
  );
}

function baseCrudSteps({
  name,
  def,
  fks,
  pkCol,
  collection,
  member,
  iterSteps,
  teardownSteps,
  occ = false,
}: CrudLaneArgs & { collection: string; member: string }): void {
  const dashName = name.replace(/_/g, "-");
  iterSteps.push({
    id: `post-${dashName}`,
    phase: "iter",
    op: "POST",
    path: collection,
    body: bodyForOp({
      op: "POST",
      entityName: name,
      typeDef: def,
      fkFields: fks,
    }),
    capture: {
      [`ids.${name}[i]`]: `$.${pkCol}`,
      ...versionCaptureFor(name, occ),
    },
  });
  iterSteps.push({
    id: `get-${plural(name)}`,
    phase: "iter",
    op: "GET",
    path: collection,
  });
  iterSteps.push({
    id: `get-${dashName}-by-id`,
    phase: "iter",
    op: "GET",
    path: member,
  });
  pushCrudMutations({
    idFor: (verb) => `${verb}-${dashName}`,
    path: member,
    pool: name,
    bodyFor: (op) =>
      bodyForOp({ op, entityName: name, typeDef: def, fkFields: fks }),
    occ,
    iterSteps,
    teardownSteps,
  });
}

/** Under `use_optimistic_concurrency`, a standard-entity mutation must send the row's current
 * `updated` token as `If-Match` (the server 428s without it), keyed on a per-entity version pool.
 * m2m links are OCC-exempt server-side, so they never get these. Empty when OCC is off — the plan
 * stays byte-identical for non-OCC samples. */
function ifMatchFor(name: string, occ: boolean): { if_match?: string } {
  return occ ? { if_match: `\${ids.${name}__v[i]}` } : {};
}

/** The POST/PATCH/PUT capture that refreshes the per-entity version pool from the response `updated`,
 * so each subsequent mutation's If-Match chains to the latest token. */
function versionCaptureFor(name: string, occ: boolean): CaptureMap {
  return occ ? { [`ids.${name}__v[i]`]: "$.updated" } : {};
}

/** The `capture` field wrapper for PATCH/PUT (which carry no other capture) — present only under OCC. */
function occCapture(name: string, occ: boolean): { capture?: CaptureMap } {
  return occ ? { capture: versionCaptureFor(name, occ) } : {};
}

/** A single OCC-aware mutation step for pool `pool`: If-Match on the write, and a version-pool refresh
 * on PATCH/PUT (DELETE ends the row, so it captures nothing). `body` omitted for DELETE. */
function mutationStep({
  id,
  phase,
  op,
  path,
  body,
  pool,
  occ,
}: {
  id: string;
  phase: PerfPhase;
  op: MutationOp;
  path: string;
  body?: TemplateBody;
  pool: string;
  occ: boolean;
}): PerfStep {
  return {
    id,
    phase,
    op,
    path,
    ...(body !== undefined ? { body } : {}),
    ...ifMatchFor(pool, occ),
    ...(op === "DELETE" ? {} : occCapture(pool, occ)),
  };
}

/** The PATCH+PUT iter mutations and the teardown DELETE for one member `path`, all keyed on version
 * pool `pool`. `idFor(verb)` names each step and `bodyFor(op)` supplies each write body — so the
 * flat and eager CRUD lanes share one OCC-aware mutation trio. */
function pushCrudMutations({
  idFor,
  path,
  pool,
  bodyFor,
  occ,
  iterSteps,
  teardownSteps,
}: {
  idFor: (verb: string) => string;
  path: string;
  pool: string;
  bodyFor: (op: string) => TemplateBody;
  occ: boolean;
  iterSteps: PerfStep[];
  teardownSteps: PerfStep[];
}): void {
  iterSteps.push(
    mutationStep({
      id: idFor("patch"),
      phase: "iter",
      op: "PATCH",
      path,
      body: bodyFor("PATCH"),
      pool,
      occ,
    }),
    mutationStep({
      id: idFor("put"),
      phase: "iter",
      op: "PUT",
      path,
      body: bodyFor("PUT"),
      pool,
      occ,
    }),
  );
  teardownSteps.push(
    mutationStep({
      id: idFor("delete"),
      phase: "iter_teardown",
      op: "DELETE",
      path,
      pool,
      occ,
    }),
  );
}

function eagerWriteSteps({
  name,
  def,
  pkCol,
  collection,
  writeNode,
  byName,
  known,
  viewByName,
  iterSteps,
  teardownSteps,
  occ = false,
}: {
  name: string;
  def: PerfTypeDef;
  pkCol: string;
  collection: string;
  writeNode: EagerNode;
  byName: Map<string, PerfTypeDef>;
  known: Set<string>;
  viewByName: Map<string, RawTypeDef>;
  iterSteps: PerfStep[];
  teardownSteps: PerfStep[];
  occ?: boolean;
}): void {
  const dashName = name.replace(/_/g, "-");
  const eagerPool = `${name}_eager`;
  const eagerPoolDash = `${dashName}-eager`;
  const eagerMember = `${collection}/\${ids.${eagerPool}[i]}`;
  const eagerBody = (mode: string): TemplateBody =>
    buildEagerWriteBody({
      parent: name,
      parentDef: def,
      parentNode: writeNode,
      viewByName,
      datasourceByName: byName,
      knownSet: known,
      mode,
    });
  iterSteps.push({
    id: `eager-post-${eagerPoolDash}`,
    phase: "iter",
    op: "POST",
    path: collection,
    body: eagerBody("POST"),
    capture: {
      [`ids.${eagerPool}[i]`]: `$.${pkCol}`,
      ...versionCaptureFor(eagerPool, occ),
    },
  });
  pushCrudMutations({
    idFor: (verb) => `eager-${verb}-${eagerPoolDash}`,
    path: eagerMember,
    pool: eagerPool,
    bodyFor: eagerBody,
    occ,
    iterSteps,
    teardownSteps,
  });
}

function eagerReadSteps(
  name: string,
  collection: string,
  member: string,
): PerfStep[] {
  const dashName = name.replace(/_/g, "-");
  return [
    {
      id: `eager-get-${plural(name)}`,
      phase: "iter",
      op: "GET",
      path: collection,
    },
    {
      id: `eager-get-${dashName}-by-id`,
      phase: "iter",
      op: "GET",
      path: member,
    },
  ];
}

function regularEntitySteps({
  name,
  def,
  byName,
  known,
  graph,
  iterSteps,
  teardownSteps,
  occ = false,
}: {
  name: string;
  def: PerfTypeDef;
  byName: Map<string, PerfTypeDef>;
  known: Set<string>;
  graph: GraphInputs;
  iterSteps: PerfStep[];
  teardownSteps: PerfStep[];
  occ?: boolean;
}): void {
  const { directFk, eagerReadRoots, eagerWriteByRoot, viewByName } = graph;
  // Drop self-referential FKs (e.g. role.parent_role_id -> role): at i=0 the entity's own id pool is empty, so `${ids.<self>[i]}` in the create body is unresolvable and the perf client crashes before any POST. The column is nullable, so omitting it is valid. Mirrors collectEagerWriteFkParents' self-parent skip.
  const fks = findFkFields(def, known, byName).filter((f) => f.parent !== name);
  const pkCol = primaryKeyColumn(def);
  const collection = `/api/${layout.apiPath(name)}`;
  const member = `${collection}/\${ids.${name}[i]}`;
  const lane: CrudLaneArgs = {
    name,
    def,
    fks,
    pkCol,
    iterSteps,
    teardownSteps,
    occ,
  };

  if (directFk.has(name)) {
    nestedFkSteps({ ...lane, meta: directFk.get(name)! });
    return;
  }

  baseCrudSteps({ ...lane, collection, member });

  if (eagerReadRoots.has(name)) {
    iterSteps.push(...eagerReadSteps(name, collection, member));
  }

  const writeNode = eagerWriteByRoot.get(name);
  if (writeNode && writeNode.children.size > 0 && viewByName.has(name)) {
    eagerWriteSteps({
      name,
      def,
      pkCol,
      collection,
      writeNode,
      byName,
      known,
      viewByName,
      iterSteps,
      teardownSteps,
      occ,
    });
  }
}

function entityOrder({
  datasourceData,
  eagerWriteByRoot,
  viewByName,
  byName,
  known,
}: {
  datasourceData: PerfDatasourceDoc;
  eagerWriteByRoot: Map<string, EagerNode>;
  viewByName: Map<string, RawTypeDef>;
  byName: Map<string, PerfTypeDef>;
  known: Set<string>;
}): string[] {
  const eagerExtraParents = new Map<string, Set<string>>();
  for (const [root, rootNode] of eagerWriteByRoot) {
    const parents = collectEagerWriteFkParents({
      root,
      rootNode,
      viewByName,
      datasourceByName: byName,
      knownSet: known,
    });
    if (parents.size > 0) eagerExtraParents.set(root, parents);
  }
  return topoSortEntities(datasourceData, eagerExtraParents);
}

// Migrated readonly-lookup entities with no seed rows. A seedless lookup is valid, but the lookup GET returns nothing, so `lookups.<name>.first_name` is null and any dependent's create body can't resolve it. skip_migrations lookups are excluded: they are seeded out-of-band via custom SQL, not the YAML `seeds:` we can see here, so we must assume they hold rows.
function emptyReadonlyLookups(byName: Map<string, PerfTypeDef>): Set<string> {
  const empty = new Set<string>();
  for (const [name, def] of byName) {
    if (classifyEntity(def) !== "readonly") continue;
    if (def?.skip_migrations === true) continue;
    if (!Array.isArray(def.seeds) || def.seeds.length === 0) empty.add(name);
  }
  return empty;
}

// True when the entity has a NON-nullable FK to a seedless readonly-lookup: it can't be created (no valid parent row exists), so the perf plan skips it. A nullable FK to an empty lookup is fine (the column is simply omitted).
function requiresEmptyLookup(
  def: PerfTypeDef,
  emptyLookups: Set<string>,
): boolean {
  for (const entry of fieldsOf(def)) {
    const fdef = Object.values(entry)[0];
    if (typeof fdef?.references !== "string") continue;
    if (fdef.is_nullable === true) continue;
    if (emptyLookups.has(fdef.references.split(".")[0])) return true;
  }
  return false;
}

function indexByName(doc: PerfDatasourceDoc): Map<string, PerfTypeDef> {
  const out = new Map<string, PerfTypeDef>();
  for (const [name, def] of indexDatasource(doc)) {
    out.set(name, def as PerfTypeDef);
  }
  return out;
}

function perfPlanInputs({
  datasourceData,
  routesData,
  viewTypesData,
  excludeEntity,
}: {
  datasourceData: PerfDatasourceDoc;
  routesData: RoutesDoc | null;
  viewTypesData: RawTypesDoc | null | undefined;
  excludeEntity: ExcludeEntityFn | null;
}): PerfPlanInputs {
  const byName = indexByName(datasourceData);
  const { directFk, m2m } = collectCombinedChildren(routesData ?? {});
  const directive = routeViewTypeDirective(
    routesData,
  ) as PerfRouteDirective | null;
  // Only exercise entities the route filter actually surfaces — otherwise the plan hits routes (secret, deterministic_item, …) that view_type_routes.filter never mounts. Absent a filter, compileRoutesFilter admits everything.
  const routeFilter = compileRoutesFilter(directive?.filter);
  const routeIncluded = (name: string): boolean =>
    routeFilter({
      name,
      kind: "datasource_type",
      inheritsNamespace: "datasource_types",
    });
  const excludedByCaller =
    typeof excludeEntity === "function"
      ? (name: string): boolean => excludeEntity(name, byName.get(name))
      : (): boolean => false;
  const emptyLookups = emptyReadonlyLookups(byName);
  // Skip an entity that can't be created because it has a non-nullable FK to a seedless readonly-lookup — otherwise its create body references `${lookups.<name>.first_name}`, which the seedless lookup never captures, and the perf client throws `unresolved lookups.<name>.first_name` and halts the run. The lookup's own (harmless, empty) GET step still generates.
  const dependsOnEmptyLookup = (name: string): boolean => {
    const def = byName.get(name);
    return def ? requiresEmptyLookup(def, emptyLookups) : false;
  };
  const isExcluded = (name: string): boolean =>
    excludedByCaller(name) ||
    !routeIncluded(name) ||
    dependsOnEmptyLookup(name);
  return {
    byName,
    known: new Set(byName.keys()),
    directFk,
    m2m,
    viewByName: indexViewTypes(viewTypesData),
    eagerReadRoots: parseEagerReadRoots(directive?.eager_path),
    eagerWriteByRoot: parseEagerWritePathsByRoot(directive?.eager_write_path),
    isExcluded,
  };
}

function lookupPhaseSteps(
  byName: Map<string, PerfTypeDef>,
  isExcluded: (name: string) => boolean,
): PerfStep[] {
  const steps: PerfStep[] = [];
  for (const [name, def] of byName) {
    if (classifyEntity(def) !== "readonly") continue;
    if (isExcluded(name)) continue;
    steps.push(...lookupSteps(name, def));
  }
  return steps;
}

function iterPhaseSteps(
  order: string[],
  inputs: PerfPlanInputs,
  {
    useOptimisticConcurrency = false,
  }: { useOptimisticConcurrency?: boolean } = {},
): { iterSteps: PerfStep[]; teardownSteps: PerfStep[] } {
  const { byName, known, m2m, directFk, eagerReadRoots, eagerWriteByRoot } =
    inputs;
  const { viewByName, isExcluded } = inputs;
  const graph = { directFk, eagerReadRoots, eagerWriteByRoot, viewByName };
  const iterSteps: PerfStep[] = [];
  const teardownSteps: PerfStep[] = [];
  for (const name of order) {
    const def = byName.get(name)!;
    if (classifyEntity(def) !== "regular") continue;
    if (isExcluded(name)) continue;
    regularEntitySteps({
      name,
      def,
      byName,
      known,
      graph,
      iterSteps,
      teardownSteps,
      occ: entityUsesOptimisticConcurrency(
        {
          datasourceType: def.datasource_type,
          optimisticConcurrency:
            def.use_optimistic_concurrency === undefined
              ? undefined
              : def.use_optimistic_concurrency === true,
        },
        useOptimisticConcurrency,
      ),
    });
  }
  for (const link of m2m) {
    if (isExcluded(link.parent) || isExcluded(link.target)) continue;
    iterSteps.push(...m2mLinkSteps(link));
  }
  return { iterSteps, teardownSteps };
}

export function buildPerformancePlan({
  datasourceData,
  routesData = {},
  viewTypesData = null,
  excludeEntity = null,
  useOptimisticConcurrency = false,
}: {
  datasourceData: PerfDatasourceDoc;
  routesData?: RoutesDoc | null;
  viewTypesData?: RawTypesDoc | null;
  excludeEntity?: ExcludeEntityFn | null;
  useOptimisticConcurrency?: boolean;
}): PerformancePlan {
  if (!datasourceData || !Array.isArray(datasourceData.types)) {
    throw new Error(
      "buildPerformancePlan: datasourceData.types must be an array",
    );
  }
  const inputs = perfPlanInputs({
    datasourceData,
    routesData,
    viewTypesData,
    excludeEntity,
  });
  const { byName, isExcluded } = inputs;
  const order = entityOrder({ datasourceData, ...inputs });

  const steps = lookupPhaseSteps(byName, isExcluded);
  const { iterSteps, teardownSteps } = iterPhaseSteps(order, inputs, {
    useOptimisticConcurrency,
  });
  steps.push(...iterSteps);
  steps.push(...teardownSteps.reverse());
  return {
    iteration_template_vars: ["randSuffix", "i"],
    steps,
  };
}
