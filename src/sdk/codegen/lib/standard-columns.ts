import type { DatasourceSettings } from "../../datasource-settings.ts";

export interface StandardColumn {
  name: string;
  type: string;
  isNullable: boolean;
}

export type ColumnDef = Omit<StandardColumn, "name">;

export const STANDARD_COLUMN_DEFS: Record<string, ColumnDef> = {
  id: { type: "number", isNullable: false },
  uuid: { type: "uuid", isNullable: false },
  created: { type: "datetime", isNullable: false },
  updated: { type: "datetime", isNullable: false },
};

export const STANDARD_COLUMN_ORDER: string[] = [
  "id",
  "uuid",
  "created",
  "updated",
];

export const INLINED_VIEW_AUDIT_FIELDS: StandardColumn[] = [
  { name: "id", type: "number", isNullable: false },
  { name: "uuid", type: "string", isNullable: false },
  { name: "created", type: "datetime", isNullable: false },
  { name: "updated", type: "datetime", isNullable: false },
];

/** Drop the injected system `uuid` column when the project's primary key IS the uuid (`!ds.withUuidColumn`) — a uuid-PK struct carries no separate `uuid` field. A no-op when `ds` is absent or the project keeps a distinct uuid column. */
export function dropSystemUuidField(
  fields: StandardColumn[],
  ds?: DatasourceSettings,
): StandardColumn[] {
  return ds && !ds.withUuidColumn
    ? fields.filter((f) => f.name !== "uuid")
    : fields;
}

export function inlinedViewAuditFieldsExcluding(
  declaredNames: Iterable<string>,
  ds?: DatasourceSettings,
): StandardColumn[] {
  const set =
    declaredNames instanceof Set ? declaredNames : new Set(declaredNames);
  return dropSystemUuidField(
    INLINED_VIEW_AUDIT_FIELDS.filter((f) => !set.has(f.name)),
    ds,
  );
}
