/** Dialect-agnostic helpers shared by the postgres/mysql/sqlserver stored-procedure generators. */
import { datasourceSettingsFor } from "../codegen/lib/ts-datasource-settings.ts";

interface ProcField {
  name: string;
  type: string;
  size?: number;
  primaryKey?: boolean;
}

interface ProcTable {
  name?: string;
  entityName?: string;
  fields: ProcField[];
}

/** The implicit primary key for an entity that declares none, keyed off the resolved `id_type`. */
export function implicitIdField(idType: string | undefined): ProcField {
  switch (idType) {
    case "uuid":
      return { name: "id", type: "uuid" };
    case "string":
      return { name: "id", type: "string", size: 64 };
    case "integer":
    case "biginteger":
    case undefined:
      return { name: "id", type: "biginteger" };
    default:
      throw new Error(`generate-procedures: unknown idType "${idType}"`);
  }
}

/** The entity's primary key: an explicit `primary_key: true` field, else the implicit id column. */
export function pkFieldOf(
  table: ProcTable,
  idType: string | undefined,
): ProcField {
  const fields = Array.isArray(table.fields) ? table.fields : [];
  const custom = fields.find((f) => f && f.primaryKey === true);
  return custom ?? implicitIdField(idType);
}

/** The writable, non-audit columns: everything but the pk, the system `uuid`, and `created`/`updated`. */
export function writableNonAuditFields(
  table: ProcTable,
  idType: string | undefined,
): ProcField[] {
  const pk = pkFieldOf(table, idType);
  return table.fields.filter(
    (f) =>
      f.name !== pk.name &&
      f.name !== "uuid" &&
      f.name !== "created" &&
      f.name !== "updated",
  );
}

// A uuid id_type makes the primary key itself the uuid, so procedures skip the separate system `uuid` column to match the table generator — else their INSERT/SELECT references a column that does not exist.
export function hasSystemUuidColumn(idType: string | undefined): boolean {
  return datasourceSettingsFor({ idType }).withUuidColumn;
}

/** The ordered column list for an entity's SELECT/INSERT: pk, the system `uuid` (unless the pk itself is the uuid), the writable columns, then `created`/`updated`. */
export function allColumnNames(
  table: ProcTable,
  idType: string | undefined,
): string[] {
  const pk = pkFieldOf(table, idType);
  return [
    pk.name,
    ...(hasSystemUuidColumn(idType) ? ["uuid"] : []),
    ...writableNonAuditFields(table, idType).map((f) => f.name),
    "created",
    "updated",
  ];
}

/** `allColumnNames` qualified with a table alias (default `t`), for the dialects whose SELECTs alias the table. */
export function aliasedColumns(
  table: ProcTable,
  idType: string | undefined,
  alias = "t",
): string {
  return allColumnNames(table, idType)
    .map((c) => `${alias}.${c}`)
    .join(", ");
}

export function paramAlignWidth(params: { name: string }[]): number {
  return params.reduce((m, p) => Math.max(m, p.name.length), 0);
}

export function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - s.length));
}

export function pluralizeEntity(name: string): string {
  if (name.endsWith("s")) return name;
  if (name.endsWith("y")) return name.slice(0, -1) + "ies";
  return name + "s";
}
