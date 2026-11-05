import {
  hasSystemUuidColumn,
  writableNonAuditFields,
  aliasedColumns,
  pluralizeEntity,
} from "./generate-procedures-common.ts";
import {
  renderInParams as renderParams,
  charParamType,
  mysqlProc,
  makeGenerateUpdate,
} from "./generate-procedures-shared.ts";
import type {
  ProcField,
  ProcTable,
  Param,
  RenderCtx,
  UpdateProcDialect,
} from "./generate-procedures-shared.ts";

export const dialectName = "mysql";
const ALIAS = "t";

export const auditType = "VARCHAR(64)";

export function paramType(field: ProcField): string {
  return charParamType(field, "VARCHAR", dialectName);
}

function renderInParams(params: Param[]): string {
  return renderParams(params, "IN ");
}

// Accepts ISO-8601 'T...Z' (from JS toISOString) and mysql-native 'YYYY-MM-DD HH:MM:SS' alike.
function mysqlValueExpr(name: string): string {
  if (
    name === "created" ||
    name === "updated" ||
    name === "new_updated" ||
    name === "expected_updated"
  ) {
    return `CAST(REPLACE(REPLACE(${name}, 'T', ' '), 'Z', '') AS DATETIME(6))`;
  }
  return name;
}

function createProcParams(
  table: ProcTable,
  idType: string | undefined,
): Param[] {
  const writable = writableNonAuditFields(table, idType);
  return [
    ...(hasSystemUuidColumn(idType)
      ? [{ name: "uuid", type: "VARCHAR(36)" }]
      : []),
    ...writable.map((f) => ({ name: f.name, type: paramType(f) })),
    { name: "created", type: "VARCHAR(64)" },
    { name: "updated", type: "VARCHAR(64)" },
  ];
}

// uuid id_type: mysql has no RETURNING and there is no system `uuid` column to look the new row up by, so generate the pk in-proc and return it directly.
function generateCreateGeneratedIdProc({
  entityName,
  table,
  idType,
  tableTok,
  pk,
}: RenderCtx): string {
  const writable = writableNonAuditFields(table, idType);
  const cols = [pk.name, ...writable.map((f) => f.name), "created", "updated"];
  const vals = [
    "new_id",
    ...writable.map((f) => f.name),
    mysqlValueExpr("created"),
    mysqlValueExpr("updated"),
  ];
  return mysqlProc(
    `create_${entityName}`,
    [
      `CREATE PROCEDURE create_${entityName}(`,
      renderInParams(createProcParams(table, idType)),
      `)`,
    ],
    [
      `  DECLARE new_id VARCHAR(36);`,
      `  SET new_id = UUID();`,
      `  INSERT INTO ${tableTok} (${cols.join(", ")})`,
      `  VALUES (${vals.join(", ")});`,
      `  SELECT new_id AS ${pk.name};`,
    ],
  );
}

export function generateCreate({
  entityName,
  table,
  idType,
  tableTok,
  pk,
}: RenderCtx): string {
  if (!hasSystemUuidColumn(idType)) {
    return generateCreateGeneratedIdProc({
      entityName,
      table,
      idType,
      tableTok,
      pk,
    });
  }
  const writable = writableNonAuditFields(table, idType);
  const cols = ["uuid", ...writable.map((f) => f.name), "created", "updated"];
  const vals = cols.map((c) => mysqlValueExpr(c));
  const selectAfterWrite =
    pk.type === "biginteger" || pk.type === "integer"
      ? `SELECT LAST_INSERT_ID() AS ${pk.name};`
      : `SELECT ${ALIAS}.${pk.name} AS ${pk.name} FROM ${tableTok} ${ALIAS} WHERE ${ALIAS}.uuid = uuid;`;
  return mysqlProc(
    `create_${entityName}`,
    [
      `CREATE PROCEDURE create_${entityName}(`,
      renderInParams(createProcParams(table, idType)),
      `)`,
    ],
    [
      `  INSERT INTO ${tableTok} (${cols.join(", ")})`,
      `  VALUES (${vals.join(", ")});`,
      `  ${selectAfterWrite}`,
    ],
  );
}

export function generateFindOne({
  entityName,
  table,
  idType,
  tableTok,
  pk,
}: RenderCtx): string {
  const pkType = paramType(pk);
  return mysqlProc(
    `find_${entityName}`,
    [`CREATE PROCEDURE find_${entityName}(IN ${pk.name} ${pkType})`],
    [
      `  SELECT ${aliasedColumns(table, idType)} FROM ${tableTok} ${ALIAS} WHERE ${ALIAS}.${pk.name} = ${pk.name};`,
    ],
  );
}

export function generateFindAll({
  entityName,
  table,
  idType,
  tableTok,
  pk,
}: RenderCtx): string {
  const plural = pluralizeEntity(entityName);
  return mysqlProc(
    `find_${plural}`,
    [`CREATE PROCEDURE find_${plural}()`],
    [
      `  SELECT ${aliasedColumns(table, idType)} FROM ${tableTok} ${ALIAS} ORDER BY ${ALIAS}.${pk.name};`,
    ],
  );
}

export function generateFindBy(
  { entityName, table, idType, tableTok }: RenderCtx,
  field: ProcField,
): string {
  const byField = field.name;
  return mysqlProc(
    `find_${entityName}_by_${byField}`,
    [
      `CREATE PROCEDURE find_${entityName}_by_${byField}(IN ${byField} ${paramType(field)})`,
    ],
    [
      `  SELECT ${aliasedColumns(table, idType)} FROM ${tableTok} ${ALIAS} WHERE ${ALIAS}.${byField} = ${byField};`,
    ],
  );
}

// argRef routes every param through mysqlValueExpr so the audit columns (created/updated/new_updated/expected_updated) get the ISO→DATETIME CAST while plain columns pass through unchanged.
const updateDialect: UpdateProcDialect = {
  colRef: (c) => `${ALIAS}.${c}`,
  setLhs: (c) => `${ALIAS}.${c}`,
  argRef: (c) => mysqlValueExpr(c),
  wrap: (ctx, { name, params }, updateLines) =>
    mysqlProc(
      name,
      [`CREATE PROCEDURE ${name}(`, renderInParams(params), `)`],
      [
        `  UPDATE ${ctx.tableTok} ${ALIAS}`,
        ...updateLines,
        `  SELECT ROW_COUNT() AS affected;`,
      ],
    ),
};

export const generateUpdate = makeGenerateUpdate(updateDialect);

export function generateDelete({ entityName, tableTok, pk }: RenderCtx): string {
  const pkType = paramType(pk);
  return mysqlProc(
    `delete_${entityName}`,
    [`CREATE PROCEDURE delete_${entityName}(IN ${pk.name} ${pkType})`],
    [
      `  DELETE ${ALIAS} FROM ${tableTok} ${ALIAS} WHERE ${ALIAS}.${pk.name} = ${pk.name};`,
      `  SELECT ROW_COUNT() AS affected;`,
    ],
  );
}

export function generateDeleteOcc(
  { entityName, tableTok, pk }: RenderCtx,
  params: Param[],
): string {
  return mysqlProc(
    `delete_${entityName}_optimistic_concurrency`,
    [
      `CREATE PROCEDURE delete_${entityName}_optimistic_concurrency(`,
      renderInParams(params),
      `)`,
    ],
    [
      `  DELETE ${ALIAS} FROM ${tableTok} ${ALIAS}`,
      `  WHERE ${ALIAS}.${pk.name} = ${pk.name} AND ${ALIAS}.updated = ${mysqlValueExpr("expected_updated")};`,
      `  SELECT ROW_COUNT() AS affected;`,
    ],
  );
}
