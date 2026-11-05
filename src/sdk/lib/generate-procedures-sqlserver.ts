import {
  pkFieldOf,
  writableNonAuditFields,
  pluralizeEntity,
} from "./generate-procedures-common.ts";
import {
  renderInParams as renderParams,
  charParamType,
  sqlserverProc,
  makeGenerateUpdate,
} from "./generate-procedures-shared.ts";
import type {
  ProcField,
  ProcTable,
  Param,
  RenderCtx,
  UpdateProcDialect,
} from "./generate-procedures-shared.ts";

export const dialectName = "sqlserver";

export const auditType = "NVARCHAR(64)";

export function paramType(field: ProcField): string {
  return charParamType(field, "NVARCHAR", dialectName);
}

// sqlserver keeps the system `uuid` column in its SELECT lists even under a uuid id_type (see generate-procedures-sqlserver-id-type.test.mjs) — divergent from postgres/mysql, so it is NOT the conditional `allColumnNames` in generate-procedures-common.
function allColumnNames(
  table: ProcTable,
  idType: string | undefined,
): string[] {
  const pk = pkFieldOf(table, idType);
  return [
    pk.name,
    "uuid",
    ...writableNonAuditFields(table, idType).map((f) => f.name),
    "created",
    "updated",
  ];
}

function renderInParams(params: Param[]): string {
  return renderParams(params, "@");
}

export function generateCreate({
  entityName,
  table,
  idType,
  tableTok,
}: RenderCtx): string {
  const writable = writableNonAuditFields(table, idType);
  const params: Param[] = [
    { name: "uuid", type: "NVARCHAR(36)" },
    ...writable.map((f) => ({ name: f.name, type: paramType(f) })),
    { name: "created", type: "NVARCHAR(64)" },
    { name: "updated", type: "NVARCHAR(64)" },
  ];
  const cols = ["uuid", ...writable.map((f) => f.name), "created", "updated"];
  const placeholders = cols.map((c) => `@${c}`);
  return sqlserverProc(
    [`CREATE OR ALTER PROCEDURE create_${entityName}`, renderInParams(params)],
    [
      `  INSERT INTO ${tableTok} (${cols.join(", ")})`,
      `  VALUES (${placeholders.join(", ")});`,
      `  SELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS id;`,
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
  const cols = allColumnNames(table, idType).join(", ");
  const pkType = paramType(pk);
  return sqlserverProc(
    [`CREATE OR ALTER PROCEDURE find_${entityName} @${pk.name} ${pkType}`],
    [`  SELECT ${cols} FROM ${tableTok} WHERE ${pk.name} = @${pk.name};`],
  );
}

export function generateFindAll({
  entityName,
  table,
  idType,
  tableTok,
  pk,
}: RenderCtx): string {
  const cols = allColumnNames(table, idType).join(", ");
  return sqlserverProc(
    [`CREATE OR ALTER PROCEDURE find_${pluralizeEntity(entityName)}`],
    [`  SELECT ${cols} FROM ${tableTok} ORDER BY ${pk.name};`],
  );
}

export function generateFindBy(
  { entityName, table, idType, tableTok }: RenderCtx,
  field: ProcField,
): string {
  const byField = field.name;
  const cols = allColumnNames(table, idType).join(", ");
  return sqlserverProc(
    [
      `CREATE OR ALTER PROCEDURE find_${entityName}_by_${byField} @${byField} ${paramType(field)}`,
    ],
    [`  SELECT ${cols} FROM ${tableTok} WHERE ${byField} = @${byField};`],
  );
}

// sqlserver aliases nothing: colRef/setLhs are bare and argRef is the `@param` marker.
const updateDialect: UpdateProcDialect = {
  colRef: (c) => c,
  setLhs: (c) => c,
  argRef: (c) => `@${c}`,
  wrap: (ctx, { name, params }, updateLines) =>
    sqlserverProc(
      [`CREATE OR ALTER PROCEDURE ${name}`, renderInParams(params)],
      [
        `  UPDATE ${ctx.tableTok}`,
        ...updateLines,
        `  SELECT @@ROWCOUNT AS affected;`,
      ],
    ),
};

export const generateUpdate = makeGenerateUpdate(updateDialect);

export function generateDelete({ entityName, tableTok, pk }: RenderCtx): string {
  const pkType = paramType(pk);
  return sqlserverProc(
    [`CREATE OR ALTER PROCEDURE delete_${entityName} @${pk.name} ${pkType}`],
    [
      `  DELETE FROM ${tableTok} WHERE ${pk.name} = @${pk.name};`,
      `  SELECT @@ROWCOUNT AS affected;`,
    ],
  );
}

export function generateDeleteOcc(
  { entityName, tableTok, pk }: RenderCtx,
  params: Param[],
): string {
  return sqlserverProc(
    [
      `CREATE OR ALTER PROCEDURE delete_${entityName}_optimistic_concurrency`,
      renderInParams(params),
    ],
    [
      `  DELETE FROM ${tableTok}`,
      `  WHERE ${pk.name} = @${pk.name} AND updated = @expected_updated;`,
      `  SELECT @@ROWCOUNT AS affected;`,
    ],
  );
}
