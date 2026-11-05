import { indexDatasourceByName } from "../../lib/datasource-index.ts";
import { buildDatasourceFixture } from "./fixture-builder.ts";
import { effectiveTableName } from "../../lib/effective-table-name.ts";

const STANDARD_COLUMNS = new Set(["id", "uuid", "created", "updated"]);

type Datasource = Parameters<typeof indexDatasourceByName>[0];

interface FieldDef {
  references?: string;
  is_nullable?: boolean;
}

interface EntityDef {
  fields?: Array<Record<string, FieldDef>>;
  seeds?: unknown[];
}

interface ForeignKey {
  column: string;
  parentTable: string;
  isNullable: boolean;
}

interface FkColumn {
  column: string;
  parentTable: string;
}

type SeedStep =
  | { table: string; kind: "lookup" }
  | {
      table: string;
      kind: "create";
      scalars: Record<string, unknown>;
      fkColumns: FkColumn[];
      nullFkColumns: string[];
    };

export interface FkSeedPlan {
  needsSeed: boolean;
  entityFkColumns: FkColumn[];
  entityNullFkColumns: string[];
  steps: SeedStep[];
  stripOrder: string[];
}

interface FkSeedPlanOptions {
  datasource?: Datasource;
  datetime?: string;
  pluralizeTableNames?: boolean;
}

interface SeedPlanCtx {
  byName: Map<string, unknown>;
  phys: (table: string) => string;
  steps: SeedStep[];
  resolved: Set<string>;
  visiting: Set<string>;
  datasource?: Datasource;
  datetime?: string;
}

type ClassifiedColumn =
  | { column: string; kind: "fk"; parentTable: string }
  | { column: string; kind: "null" }
  | { column: string; kind: "literal"; value: unknown };

function fieldsOf(def?: EntityDef): Array<Record<string, FieldDef>> {
  const fields = def?.fields;
  return Array.isArray(fields) ? fields : [];
}

/** Every field of `def` that declares a `references: <table>.<column>` foreign key. */
export function foreignKeysOf(def?: EntityDef): ForeignKey[] {
  const fks: ForeignKey[] = [];
  for (const field of fieldsOf(def)) {
    const entry = Object.entries(field)[0];
    if (!entry) continue;
    const [column, fdef] = entry;
    if (typeof fdef.references !== "string") continue;
    const [parentTable] = fdef.references.split(".");
    fks.push({
      column,
      parentTable,
      isNullable: fdef.is_nullable === true,
    });
  }
  return fks;
}

/** A parent row already exists in the prebuilt/migrated DB when the table carries seeds. */
export function isSeeded(def?: EntityDef): boolean {
  const seeds = def?.seeds;
  return Array.isArray(seeds) && seeds.length > 0;
}

function scalarsFor(
  table: string,
  { datasource, datetime }: { datasource?: Datasource; datetime?: string },
  referenceColumns: Set<string>,
): Record<string, unknown> {
  const fixture = buildDatasourceFixture({ table, datasource, datetime });
  const scalars: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fixture)) {
    if (STANDARD_COLUMNS.has(key)) continue;
    if (referenceColumns.has(key)) continue;
    scalars[key] = value;
  }
  return scalars;
}

function ensureParent(table: string, ctx: SeedPlanCtx): void {
  const { byName, phys, steps, resolved, visiting } = ctx;
  if (resolved.has(table)) return;
  const def = byName.get(table) as EntityDef | undefined;
  if (!def) {
    throw new Error(`resolveFkSeedPlan: unknown parent table "${table}"`);
  }
  if (isSeeded(def)) {
    steps.push({ table: phys(table), kind: "lookup" });
    resolved.add(table);
    return;
  }
  if (visiting.has(table)) {
    throw new Error(
      `resolveFkSeedPlan: non-nullable FK cycle through "${table}" — cannot seed a parent that depends on itself`,
    );
  }
  visiting.add(table);
  const { fkColumns, nullFkColumns, referenceColumns } = splitForeignKeys(def);
  for (const fk of fkColumns) ensureParent(fk.parentTable, ctx);
  visiting.delete(table);
  steps.push({
    table: phys(table),
    kind: "create",
    scalars: scalarsFor(
      table,
      { datasource: ctx.datasource, datetime: ctx.datetime },
      referenceColumns,
    ),
    fkColumns: physFkColumns(fkColumns, phys),
    nullFkColumns,
  });
  resolved.add(table);
}

/**
 * Resolve the ordered plan to seed an entity's FK parents with REAL rows so a
 * `create` never references a non-existent id. Seeded parents (readonly-lookup
 * or any table with `seeds:`) are looked up; the rest are created recursively.
 * Returns `steps` in dependency order (parents before children), the entity's
 * own FK columns bound to those parents, and the reverse-dependency delete order.
 *
 * All generated table names are the settings-resolved PHYSICAL names (via
 * `effectiveTableName`, which applies `pluralize_datatable_names`) so the SQL,
 * repository, and strip references match the real tables. Internal graph
 * traversal keys on the schema entity name; the map keys the generators build
 * from `steps[].table` / `parentTable` are physical and therefore consistent.
 */
export function resolveFkSeedPlan(
  entityName: string,
  { datasource, datetime, pluralizeTableNames = false }: FkSeedPlanOptions = {},
): FkSeedPlan {
  const byName = indexDatasourceByName(datasource);
  const phys = (table: string) =>
    effectiveTableName(table, pluralizeTableNames);
  const steps: SeedStep[] = [];
  const ctx: SeedPlanCtx = {
    byName,
    phys,
    steps,
    resolved: new Set(),
    visiting: new Set(),
    datasource,
    datetime,
  };

  const entityDef = byName.get(entityName) as EntityDef | undefined;
  if (!entityDef) {
    throw new Error(`resolveFkSeedPlan: unknown entity "${entityName}"`);
  }
  const { fkColumns: rawEntityFkColumns, nullFkColumns: entityNullFkColumns } =
    splitForeignKeys(entityDef);
  for (const fk of rawEntityFkColumns) ensureParent(fk.parentTable, ctx);

  const createTables = steps
    .filter((s) => s.kind === "create")
    .map((s) => s.table);
  const stripOrder = [phys(entityName), ...createTables.slice().reverse()];

  return {
    needsSeed: rawEntityFkColumns.length > 0,
    entityFkColumns: physFkColumns(rawEntityFkColumns, phys),
    entityNullFkColumns,
    steps,
    stripOrder,
  };
}

function physFkColumns(
  fkColumns: FkColumn[],
  phys: (table: string) => string,
): FkColumn[] {
  return fkColumns.map((fk) => ({
    column: fk.column,
    parentTable: phys(fk.parentTable),
  }));
}

/**
 * Tag each of the entity's `sample` columns for the FK-seeding generators (field
 * order preserved): an FK column bound to its physical parent table, a nullable
 * FK (`null`), or a plain literal. Both the rust and TS generators render this
 * one classification in their own syntax.
 */
export function classifyEntitySampleColumns(
  sample: Record<string, unknown>,
  plan: FkSeedPlan,
): ClassifiedColumn[] {
  const parentByColumn = new Map(
    plan.entityFkColumns.map((fk) => [fk.column, fk.parentTable]),
  );
  const nullColumns = new Set(plan.entityNullFkColumns);
  return Object.entries(sample).map(([column, value]): ClassifiedColumn => {
    if (parentByColumn.has(column)) {
      return { column, kind: "fk", parentTable: parentByColumn.get(column)! };
    }
    if (nullColumns.has(column)) return { column, kind: "null" };
    return { column, kind: "literal", value };
  });
}

function splitForeignKeys(def?: EntityDef): {
  fkColumns: FkColumn[];
  nullFkColumns: string[];
  referenceColumns: Set<string>;
} {
  const fkColumns: FkColumn[] = [];
  const nullFkColumns: string[] = [];
  const referenceColumns = new Set<string>();
  for (const fk of foreignKeysOf(def)) {
    referenceColumns.add(fk.column);
    if (fk.isNullable) {
      nullFkColumns.push(fk.column);
    } else {
      fkColumns.push({ column: fk.column, parentTable: fk.parentTable });
    }
  }
  return { fkColumns, nullFkColumns, referenceColumns };
}
