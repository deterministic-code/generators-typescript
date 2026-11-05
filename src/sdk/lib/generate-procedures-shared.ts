/** The CRUD stored-procedure driver shared by the postgres/mysql/sqlserver generators: the canonical operation set and routine names (`procedureSpecs`), the per-op fan-out (`generateProceduresFor`), and the dialect-parameterized param rendering + char-type mapping. The dialect-specific SQL bodies stay in each dialect module's `generate*` ops; everything that is the same across dialects lives here so the CREATE order and the down-migration DROP names cannot drift. */
import { q, mapColumnType } from "./generate-sql.ts";
import {
  pkFieldOf,
  writableNonAuditFields,
  paramAlignWidth,
  pad,
  pluralizeEntity,
} from "./generate-procedures-common.ts";

export interface ProcField {
  name: string;
  type: string;
}

export interface ProcTable {
  name: string;
  entityName: string;
  fields: ProcField[];
}

export interface Param {
  name: string;
  type: string;
}

export interface Variant {
  occ?: boolean;
  byField?: string;
}

type ProcOp =
  | "create"
  | "findOne"
  | "findAll"
  | "findBy"
  | "update"
  | "updateOcc"
  | "updateBy"
  | "delete"
  | "deleteOcc";

interface ProcSpec {
  op: ProcOp;
  name: string;
  byField?: string;
}

export interface RenderCtx {
  entityName: string;
  table: ProcTable;
  idType?: string;
  tableTok: string;
  pk: ProcField;
}

export interface UpdateSpec {
  pk: ProcField;
  keyField: ProcField;
  writable: ProcField[];
  name: string;
  params: Param[];
}

export interface Dialect {
  dialectName: string;
  auditType: string;
  paramType(field: ProcField): string;
  generateCreate(ctx: RenderCtx): string;
  generateFindOne(ctx: RenderCtx): string;
  generateFindAll(ctx: RenderCtx): string;
  generateFindBy(ctx: RenderCtx, field: ProcField): string;
  generateUpdate(ctx: RenderCtx, variant: Variant, spec: UpdateSpec): string;
  generateDelete(ctx: RenderCtx): string;
  generateDeleteOcc(ctx: RenderCtx, params: Param[]): string;
}

interface ProcedureSpecOpts {
  byFields?: string[];
  occ?: boolean;
}

interface GenerateProceduresOpts {
  byFields?: string[];
  useOptimisticConcurrency?: boolean;
  idType?: string;
}

/** The ordered CRUD operations and their routine names for one entity — the single source both the per-dialect fan-out and `listProcedureNames` (down-migration DROPs) consume. */
export function procedureSpecs(
  entityName: string,
  { byFields = [], occ = false }: ProcedureSpecOpts = {},
): ProcSpec[] {
  const plural = pluralizeEntity(entityName);
  const specs: ProcSpec[] = [
    { op: "create", name: `create_${entityName}` },
    { op: "findOne", name: `find_${entityName}` },
    { op: "findAll", name: `find_${plural}` },
  ];
  for (const bf of byFields) {
    specs.push({
      op: "findBy",
      name: `find_${entityName}_by_${bf}`,
      byField: bf,
    });
  }
  specs.push({ op: "update", name: `update_${entityName}` });
  if (occ) {
    specs.push({
      op: "updateOcc",
      name: `update_${entityName}_optimistic_concurrency`,
    });
  }
  for (const bf of byFields) {
    specs.push({
      op: "updateBy",
      name: `update_${entityName}_by_${bf}`,
      byField: bf,
    });
  }
  specs.push({ op: "delete", name: `delete_${entityName}` });
  if (occ) {
    specs.push({
      op: "deleteOcc",
      name: `delete_${entityName}_optimistic_concurrency`,
    });
  }
  return specs;
}

function variantForOp(op: string, byField?: string): Variant {
  if (op === "updateOcc") return { occ: true };
  if (op === "updateBy") return { byField };
  return {};
}

function renderOp(dialect: Dialect, spec: ProcSpec, ctx: RenderCtx): string {
  switch (spec.op) {
    case "create":
      return dialect.generateCreate(ctx);
    case "findOne":
      return dialect.generateFindOne(ctx);
    case "findAll":
      return dialect.generateFindAll(ctx);
    case "findBy":
      return dialect.generateFindBy(
        ctx,
        requireField(
          ctx.table,
          spec.byField,
          `find_${ctx.entityName}_by_${spec.byField}`,
        ),
      );
    case "update":
    case "updateOcc":
    case "updateBy": {
      const variant = variantForOp(spec.op, spec.byField);
      return dialect.generateUpdate(
        ctx,
        variant,
        updateSpec(dialect, ctx, variant),
      );
    }
    case "delete":
      return dialect.generateDelete(ctx);
    case "deleteOcc":
      return dialect.generateDeleteOcc(
        ctx,
        deleteOccParams(dialect, pkFieldOf(ctx.table, ctx.idType)),
      );
  }
}

/** Fan a dialect module (its `generate*` op functions + `paramType`/`auditType`) over an entity's `procedureSpecs`, in canonical order. The driver owns every cross-dialect computation — the plan/params, the by-field lookup, the delete-occ params — passed to the dialect ops via a shared `ctx`, so the dialect modules hold only their unique SQL templates. */
export function generateProceduresFor(
  dialect: Dialect,
  table: ProcTable,
  opts: GenerateProceduresOpts = {},
): string[] {
  const entityName = table.entityName;
  const byFields = opts.byFields ?? [];
  const occ = opts.useOptimisticConcurrency === true;
  const idType = opts.idType;
  const ctx: RenderCtx = {
    entityName,
    table,
    idType,
    tableTok: q(dialect.dialectName, table.name),
    pk: pkFieldOf(table, idType),
  };
  return procedureSpecs(entityName, { byFields, occ }).map((spec) =>
    renderOp(dialect, spec, ctx),
  );
}

/** Wrap a plpgsql function body: `<header> DECLARE <declares> BEGIN <body> END; $$;`. Postgres CREATE/UPDATE/DELETE routines share this skeleton; the find ops are `LANGUAGE sql` one-liners and stay inline. */
export function plpgsqlFunction(
  headerLines: string[],
  declares: string[],
  bodyLines: string[],
): string {
  return [
    ...headerLines,
    `DECLARE`,
    ...declares,
    `BEGIN`,
    ...bodyLines,
    `END;`,
    `$$;`,
  ].join("\n");
}

/** Wrap a mysql procedure body: `DROP PROCEDURE IF EXISTS <name>; GO <header> BEGIN <body> END; GO`. */
export function mysqlProc(
  name: string,
  headerLines: string[],
  bodyLines: string[],
): string {
  return [
    `DROP PROCEDURE IF EXISTS ${name};`,
    `GO`,
    ...headerLines,
    `BEGIN`,
    ...bodyLines,
    `END;`,
    `GO`,
  ].join("\n");
}

/** Wrap a sqlserver procedure body: `<header> AS BEGIN <body> END; GO`. */
export function sqlserverProc(
  headerLines: string[],
  bodyLines: string[],
): string {
  return [...headerLines, `AS`, `BEGIN`, ...bodyLines, `END;`, `GO`].join("\n");
}

/** The `SET <cols> WHERE <cond>` body lines shared by every dialect's update procedure — `setLines` is the dialect's aligned SET column list, `where` its dialect-specific predicate. */
export function setAndWhere(setLines: string[], where: string): string[] {
  return [
    `  SET ${setLines.join("\n").replace(/^      /, "")}`,
    `  WHERE ${where};`,
  ];
}

/** Render aligned `IN`/`@`/bare procedure params — `prefix` is the dialect's param marker (`""` postgres, `"IN "` mysql, `"@"` sqlserver). */
export function renderInParams(params: Param[], prefix = ""): string {
  const width = paramAlignWidth(params);
  return params
    .map((p) => `  ${prefix}${pad(p.name, width)} ${p.type}`)
    .join(",\n");
}

/** The char-column-family param type shared by mysql/sqlserver: bigint pk, the fixed uuid/audit string widths (`text` is `VARCHAR`/`NVARCHAR`), else the dialect's mapped column type. */
export function charParamType(
  field: ProcField,
  text: string,
  dialect: string,
): string {
  if (field.type === "biginteger") return "BIGINT";
  if (field.name === "uuid") return `${text}(36)`;
  if (field.name === "created" || field.name === "updated")
    return `${text}(64)`;
  return mapColumnType(dialect, field);
}

/** Resolve a by-field column, throwing the standard "not declared" error keyed by the procedure name. */
export function requireField(
  table: ProcTable,
  byField: string | undefined,
  procName: string,
): ProcField {
  const field = table.fields.find((f) => f.name === byField);
  if (!field) {
    throw new Error(
      `${procName}: field "${byField}" not declared on entity "${table.entityName}"`,
    );
  }
  return field;
}

interface UpdateWhereParts {
  byField(byField: string): string;
  occ(pkName: string): string;
  plain(pkName: string): string;
}

/** Select the update procedure's WHERE predicate for a `Variant`: the by-field key, the optimistic-concurrency guard, or the plain primary-key match. */
function updateWhere(
  variant: Variant,
  pk: ProcField,
  parts: UpdateWhereParts,
): string {
  if (variant.byField) return parts.byField(variant.byField);
  if (variant.occ === true) return parts.occ(pk.name);
  return parts.plain(pk.name);
}

/** The per-dialect rendering an update procedure varies on: the WHERE column reference (`colRef`, alias-qualified where the dialect aliases its UPDATE), the SET target (`setLhs`, always bare on postgres which forbids an alias there), the parameter reference (`argRef` — the `@`/fn-qualified marker or the mysql datetime CAST), and the `wrap` that skins the assembled UPDATE body in the dialect's CREATE header + rowcount tail. */
export interface UpdateProcDialect {
  colRef(col: string): string;
  setLhs(col: string): string;
  argRef(col: string, procName: string): string;
  wrap(ctx: RenderCtx, spec: UpdateSpec, updateLines: string[]): string;
}

/** Bind a dialect's update rendering into the `generateUpdate` op the `Dialect` interface requires: assemble the shared WHERE-variant predicate and the `SET col = arg` list, then hand them to the dialect's `wrap` for its proc skeleton. Each dialect module exports `makeGenerateUpdate(updateDialect)`, so the assembly stays the single copy. Direct assignment (no COALESCE) — PATCH-merge happens in the service/repository layer, and COALESCE in-proc made setting a nullable column to NULL impossible. */
export function makeGenerateUpdate(
  d: UpdateProcDialect,
): (ctx: RenderCtx, variant: Variant, spec: UpdateSpec) => string {
  return (ctx, variant, spec) => {
    const argOf = (col: string) => d.argRef(col, spec.name);
    const where = updateWhere(variant, spec.pk, {
      byField: (bf) => `${d.colRef(bf)} = ${argOf(bf)}`,
      occ: (n) =>
        `${d.colRef(n)} = ${argOf(n)} AND ${d.colRef("updated")} = ${argOf("expected_updated")}`,
      plain: (n) => `${d.colRef(n)} = ${argOf(n)}`,
    });
    const setLines = [
      ...spec.writable.map(
        (f) => `      ${d.setLhs(f.name)}    = ${argOf(f.name)},`,
      ),
      `      ${d.setLhs("updated")} = ${argOf("new_updated")}`,
    ];
    return d.wrap(ctx, spec, setAndWhere(setLines, where));
  };
}

/** The dialect-independent shape of an update procedure — routine name, key column, writable columns, and the ordered param list — built from the render `ctx` and the dialect's `paramType`/`auditType`. Covers plain, optimistic-concurrency, and by-field variants; the SQL body + WHERE stay in the caller. */
export function updateSpec(
  dialect: Dialect,
  { entityName, table, idType }: RenderCtx,
  variant: Variant,
): UpdateSpec {
  const { occ = false, byField } = variant;
  const pk = pkFieldOf(table, idType);
  const keyField = byField
    ? requireField(table, byField, `update_${entityName}_by_${byField}`)
    : pk;
  const writable = writableNonAuditFields(table, idType).filter(
    (f: ProcField) => f.name !== byField,
  );
  const name = byField
    ? `update_${entityName}_by_${byField}`
    : occ
      ? `update_${entityName}_optimistic_concurrency`
      : `update_${entityName}`;
  const params = [
    { name: keyField.name, type: dialect.paramType(keyField) },
    ...(occ ? [{ name: "expected_updated", type: dialect.auditType }] : []),
    ...writable.map((f: ProcField) => ({
      name: f.name,
      type: dialect.paramType(f),
    })),
    { name: "new_updated", type: dialect.auditType },
  ];
  return { pk, keyField, writable, name, params };
}

/** The two params of an optimistic-concurrency delete: the pk and the `expected_updated` guard. */
export function deleteOccParams(dialect: Dialect, pk: ProcField): Param[] {
  return [
    { name: pk.name, type: dialect.paramType(pk) },
    { name: "expected_updated", type: dialect.auditType },
  ];
}
