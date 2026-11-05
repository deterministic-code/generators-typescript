/** CRUD-block helpers for the client-live lifecycle test lane (`client-live-lifecycle.ts`). Pure (no I/O, no TS-source emission): every export operates on the parsed OpenAPI document and returns plain JS values (booleans, strings, seed-dependency arrays) that drive deterministic CRUD test coverage from shared primitives. */
import { resolveRef } from "../../sdk/codegen/lib/schema-sample.ts";
import {
  operationRequestSchema,
  operationResponseSchema,
} from "../../sdk/codegen/lib/openapi-doc-helpers.ts";
import type {
  Bucket,
  OpenApiDocument,
  OpenApiPathItem,
  OpenApiSchema,
} from "../../sdk/codegen/lib/openapi-types.ts";

export {
  hasOp,
  methodsOf,
  operationRequestSchema,
  stripStubOperations,
  groupBuckets,
  classifyBucket,
} from "../../sdk/codegen/lib/openapi-doc-helpers.ts";

export {
  camelToSnake,
  snakeToCamel,
} from "../../sdk/case.ts";

interface SeedDep {
  field: string;
  parentBucket: Bucket;
  parentEntity: string;
  capture: string;
  pathParam?: boolean;
}

interface DepCtx {
  doc: OpenApiDocument;
  bucket: Bucket;
  allBuckets: Bucket[];
}

export function bucketGetItemsRefName(bucket: Bucket): string | null {
  const getOp = bucket.classification?.collectionItem?.get;
  if (!getOp) return null;
  const respInfo = operationResponseSchema(getOp);
  if (!respInfo) return null;
  const itemsRef = respInfo.schema?.properties?.items?.items?.$ref;
  if (typeof itemsRef !== "string") return null;
  return itemsRef.replace("#/components/schemas/", "");
}

function pathParamCount(p: string): number {
  return (p.match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) ?? []).length;
}

export function memberEntityFromGetResp(
  memberItem: OpenApiPathItem,
): string | null {
  const getOp = memberItem?.get;
  if (!getOp) return null;
  const respInfo = operationResponseSchema(getOp);
  const ref = respInfo?.schema?.$ref;
  if (typeof ref !== "string") return null;
  return ref.replace("#/components/schemas/", "");
}

/** The entity a member GET returns when its response is an array envelope (`{ items: [$ref] }`) rather than a single object — the byField list shape, where the member path itself returns the collection. */
export function memberEntityFromCollectionResp(
  memberItem: OpenApiPathItem,
): string | null {
  const getOp = memberItem?.get;
  if (!getOp) return null;
  const info = operationResponseSchema(getOp);
  const itemsRef = info?.schema?.properties?.items?.items?.$ref;
  if (typeof itemsRef !== "string") return null;
  return itemsRef.replace("#/components/schemas/", "");
}

function bestBucketOf(matches: Bucket[]): Bucket | null {
  if (matches.length === 0) return null;
  matches.sort(
    (a, b) =>
      pathParamCount(a.collectionPath) - pathParamCount(b.collectionPath),
  );
  return matches[0];
}

export function findBucketForEntity(
  entityName: string,
  buckets: Bucket[],
): Bucket | null {
  // Prefer the simplest top-level collection (no parent path params) when multiple buckets surface the same entity. e.g. both /api/contacts (CRUD) and /api/contact-groups/{id}/members (M2M link) return `contact`; only /api/contacts can actually CREATE a new contact, so it's the right seed target. M2M link routes only link existing children.
  const exact = buckets.filter((b) => bucketGetItemsRefName(b) === entityName);
  const exactPick = bestBucketOf(exact);
  if (exactPick) return exactPick;
  // Suffix match. e.g. field "category_name" -> entity="category" -> match parent entity "product_category" (suffix "_category"). This covers the deterministic convention where `<col>_id` on a child becomes `<col>_name` in the projection, but `<col>` is just the column-prefix — the actual parent table can be `<anything>_<col>`.
  const suffix = buckets.filter((b) => {
    const refName = bucketGetItemsRefName(b);
    return refName && refName.endsWith(`_${entityName}`);
  });
  return bestBucketOf(suffix);
}

function analyzePathParamDeps(bucket: Bucket, allBuckets: Bucket[]): SeedDep[] {
  const deps: SeedDep[] = [];
  const segments = bucket.collectionPath.split("/").filter((s) => s !== "");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const m = seg.match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (!m) continue;
    const placeholder = m[1];
    const parentCollectionPath = "/" + segments.slice(0, i).join("/");
    const parentBucket = allBuckets.find(
      (b) => b.collectionPath === parentCollectionPath,
    );
    if (!parentBucket) continue;
    const parentEntity = bucketGetItemsRefName(parentBucket) ?? placeholder;
    deps.push({
      field: placeholder,
      parentBucket,
      parentEntity,
      capture: "id",
      pathParam: true,
    });
  }
  return deps;
}

/** A `<x>_id` field whose type marks it as a foreign key in an x-references-less spec: an integer id, or a uuid-format string id. */
function isSuffixFkType(prop: OpenApiSchema): boolean {
  return (
    prop.type === "number" ||
    prop.type === "integer" ||
    (prop.type === "string" && prop.format === "uuid")
  );
}

/** The authoritative FK marker: `x-references: <entity>.<col>` resolves to the parent bucket regardless of field naming. Null when absent or the target isn't a distinct parent bucket (caller then falls back to the suffix heuristics). */
function xReferencesDep(
  field: string,
  prop: OpenApiSchema,
  ctx: DepCtx,
): SeedDep | null {
  const xRef =
    typeof prop["x-references"] === "string" ? prop["x-references"] : null;
  if (!xRef) return null;
  const [refEntity, refCol] = xRef.split(".");
  const parent = refEntity
    ? findBucketForEntity(refEntity, ctx.allBuckets)
    : null;
  if (!parent || parent === ctx.bucket) return null;
  return {
    field,
    parentBucket: parent,
    parentEntity: bucketGetItemsRefName(parent) ?? refEntity,
    capture: refCol || "id",
  };
}

/** Suffix fallback for specs without x-references: a `<x>_id` FK captures the parent's id. */
function suffixIdDep(field: string, ctx: DepCtx): SeedDep | null {
  const parent = findBucketForEntity(field.slice(0, -3), ctx.allBuckets);
  if (!parent || parent === ctx.bucket) return null;
  return {
    field,
    parentBucket: parent,
    parentEntity: bucketGetItemsRefName(parent) ?? field.slice(0, -3),
    capture: "id",
  };
}

/** Suffix fallback for a `<x>_name` field that resolves to a parent whose schema exposes a `name` column. */
function suffixNameDep(field: string, ctx: DepCtx): SeedDep | null {
  const parent = findBucketForEntity(field.slice(0, -5), ctx.allBuckets);
  if (!parent || parent === ctx.bucket) return null;
  const parentEntity = bucketGetItemsRefName(parent);
  if (!parentEntity) return null;
  const parentSchema = ctx.doc.components?.schemas?.[parentEntity];
  if (!parentSchema?.properties?.name) return null;
  return { field, parentBucket: parent, parentEntity, capture: "name" };
}

/** Resolve one required create-body field to a parent-seed dependency (x-references first, then `_id` / `_name` suffix heuristics), or null when it isn't an FK. */
function resolveFieldDep(
  field: string,
  prop: OpenApiSchema,
  ctx: DepCtx,
): SeedDep | null {
  if (!prop || prop.readOnly) return null;
  // enum values are sampled as enum[0], a server-validated lookup name — no parent seed needed.
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return null;
  const byRef = xReferencesDep(field, prop, ctx);
  if (byRef) return byRef;
  if (field.endsWith("_id") && isSuffixFkType(prop)) {
    return suffixIdDep(field, ctx);
  }
  if (field.endsWith("_name") && prop.type === "string") {
    return suffixNameDep(field, ctx);
  }
  return null;
}

export function analyzeDeps(
  bucket: Bucket,
  doc: OpenApiDocument,
  allBuckets: Bucket[],
): SeedDep[] {
  const pathDeps = analyzePathParamDeps(bucket, allBuckets);
  const post = bucket.classification?.collectionItem?.post;
  const reqSchema = post ? operationRequestSchema(post) : null;
  if (!reqSchema) return pathDeps;
  const resolved = reqSchema.$ref ? resolveRef(reqSchema.$ref, doc) : reqSchema;
  if (!resolved) return pathDeps;
  const required = Array.isArray(resolved.required) ? resolved.required : [];
  const props = resolved.properties ?? {};
  const ctx: DepCtx = { doc, bucket, allBuckets };
  const deps = [...pathDeps];
  for (const field of required) {
    const dep = resolveFieldDep(field, props[field], ctx);
    if (dep) deps.push(dep);
  }
  return deps;
}

/** Returns the trailing `{<param>}` name from a member path, or "id". */
export function memberPathParamName(memberPath: string): string {
  if (typeof memberPath !== "string") return "id";
  const m = memberPath.match(/\{([A-Za-z_][A-Za-z0-9_]*)\}\s*$/);
  return m ? m[1] : "id";
}
