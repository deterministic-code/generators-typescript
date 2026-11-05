import { mapColumnType } from "./generate-sql.ts";
import {
  hasSystemUuidColumn,
  writableNonAuditFields,
  aliasedColumns,
  pluralizeEntity,
} from "./generate-procedures-common.ts";
import {
  renderInParams as renderParams,
  plpgsqlFunction,
  makeGenerateUpdate,
} from "./generate-procedures-shared.ts";
import type {
  ProcField,
  Param,
  RenderCtx,
  UpdateProcDialect,
} from "./generate-procedures-shared.ts";

export const dialectName = "postgres";
const ALIAS = "t";

export const auditType = "TIMESTAMPTZ";

export function paramType(field: ProcField): string {
  if (field.type === "biginteger") return "BIGINT";
  return mapColumnType(dialectName, field);
}

function renderInParams(params: Param[]): string {
  return renderParams(params);
}

export function generateCreate({
  entityName,
  table,
  idType,
  tableTok,
  pk,
}: RenderCtx): string {
  const writable = writableNonAuditFields(table, idType);
  const pkType = paramType(pk);
  const uuidParam: Param[] = hasSystemUuidColumn(idType)
    ? [{ name: "uuid", type: "UUID" }]
    : [];
  const params: Param[] = [
    ...uuidParam,
    ...writable.map((f) => ({ name: f.name, type: paramType(f) })),
    { name: "created", type: "TIMESTAMPTZ" },
    { name: "updated", type: "TIMESTAMPTZ" },
  ];
  const cols = [
    ...(hasSystemUuidColumn(idType) ? ["uuid"] : []),
    ...writable.map((f) => f.name),
    "created",
    "updated",
  ];
  return plpgsqlFunction(
    [
      `CREATE OR REPLACE FUNCTION create_${entityName}(`,
      renderInParams(params),
      `) RETURNS ${pkType} LANGUAGE plpgsql AS $$`,
    ],
    [`  new_id ${pkType};`],
    [
      `  INSERT INTO ${tableTok} (${cols.join(", ")})`,
      `  VALUES (${cols.join(", ")})`,
      `  RETURNING ${pk.name} INTO new_id;`,
      `  RETURN new_id;`,
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
  return [
    `CREATE OR REPLACE FUNCTION find_${entityName}(${pk.name} ${pkType}) RETURNS SETOF ${tableTok}`,
    `LANGUAGE sql AS $$ SELECT ${aliasedColumns(table, idType)} FROM ${tableTok} ${ALIAS} WHERE ${ALIAS}.${pk.name} = find_${entityName}.${pk.name}; $$;`,
  ].join("\n");
}

export function generateFindAll({
  entityName,
  table,
  idType,
  tableTok,
  pk,
}: RenderCtx): string {
  return [
    `CREATE OR REPLACE FUNCTION find_${pluralizeEntity(entityName)}() RETURNS SETOF ${tableTok}`,
    `LANGUAGE sql AS $$ SELECT ${aliasedColumns(table, idType)} FROM ${tableTok} ${ALIAS} ORDER BY ${ALIAS}.${pk.name}; $$;`,
  ].join("\n");
}

export function generateFindBy(
  { entityName, table, idType, tableTok }: RenderCtx,
  field: ProcField,
): string {
  const byField = field.name;
  const fieldType = paramType(field);
  return [
    `CREATE OR REPLACE FUNCTION find_${entityName}_by_${byField}(${byField} ${fieldType}) RETURNS SETOF ${tableTok}`,
    `LANGUAGE sql AS $$ SELECT ${aliasedColumns(table, idType)} FROM ${tableTok} ${ALIAS} WHERE ${ALIAS}.${byField} = find_${entityName}_by_${byField}.${byField}; $$;`,
  ].join("\n");
}

// colRef aliases the WHERE columns; setLhs is bare (postgres UPDATE forbids an alias on the SET target); argRef qualifies params with the fn name to avoid column-name collisions.
const updateDialect: UpdateProcDialect = {
  colRef: (c) => `${ALIAS}.${c}`,
  setLhs: (c) => c,
  argRef: (c, name) => `${name}.${c}`,
  wrap: (ctx, { name, params }, updateLines) =>
    plpgsqlFunction(
      [
        `CREATE OR REPLACE FUNCTION ${name}(`,
        renderInParams(params),
        `) RETURNS INT LANGUAGE plpgsql AS $$`,
      ],
      [`  affected INT;`],
      [
        `  UPDATE ${ctx.tableTok} ${ALIAS}`,
        ...updateLines,
        `  GET DIAGNOSTICS affected = ROW_COUNT;`,
        `  RETURN affected;`,
      ],
    ),
};

export const generateUpdate = makeGenerateUpdate(updateDialect);

export function generateDelete({ entityName, tableTok, pk }: RenderCtx): string {
  const pkType = paramType(pk);
  return plpgsqlFunction(
    [
      `CREATE OR REPLACE FUNCTION delete_${entityName}(${pk.name} ${pkType}) RETURNS INT LANGUAGE plpgsql AS $$`,
    ],
    [`  affected INT;`],
    [
      `  DELETE FROM ${tableTok} ${ALIAS} WHERE ${ALIAS}.${pk.name} = delete_${entityName}.${pk.name};`,
      `  GET DIAGNOSTICS affected = ROW_COUNT;`,
      `  RETURN affected;`,
    ],
  );
}

export function generateDeleteOcc(
  { entityName, tableTok, pk }: RenderCtx,
  params: Param[],
): string {
  return plpgsqlFunction(
    [
      `CREATE OR REPLACE FUNCTION delete_${entityName}_optimistic_concurrency(`,
      renderInParams(params),
      `) RETURNS INT LANGUAGE plpgsql AS $$`,
    ],
    [`  affected INT;`],
    [
      `  DELETE FROM ${tableTok} ${ALIAS}`,
      `  WHERE ${ALIAS}.${pk.name} = delete_${entityName}_optimistic_concurrency.${pk.name} AND ${ALIAS}.updated = delete_${entityName}_optimistic_concurrency.expected_updated;`,
      `  GET DIAGNOSTICS affected = ROW_COUNT;`,
      `  RETURN affected;`,
    ],
  );
}
