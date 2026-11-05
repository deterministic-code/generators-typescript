import { tableHasAuditColumns } from "./generate-sql.ts";
import type { SqlDialect, NormalizedTable } from "./generate-sql.ts";
import { procedureSpecs, generateProceduresFor } from "./generate-procedures-shared.ts";
import type { Dialect } from "./generate-procedures-shared.ts";
import * as postgres from "./generate-procedures-postgres.ts";
import * as mysql from "./generate-procedures-mysql.ts";
import * as sqlserver from "./generate-procedures-sqlserver.ts";

const DIALECT_MODULES: Record<string, Dialect | undefined> = {
  postgres,
  mysql,
  sqlserver,
};

const ROUTINE_KIND_BY_DIALECT: Record<string, "function" | "procedure"> = {
  postgres: "function",
  mysql: "procedure",
  sqlserver: "procedure",
};

interface ProcedureFileOpts {
  useOptimisticConcurrency?: boolean;
  idType?: string;
}

interface GenerateProcedureFileArgs {
  dialect: SqlDialect;
  tables: NormalizedTable[];
  byFieldsByEntity: Map<string, string[]>;
  opts?: ProcedureFileOpts;
}

interface RoutineName {
  kind: "function" | "procedure";
  name: string;
}

export function generateProcedureFile({
  dialect,
  tables,
  byFieldsByEntity,
  opts,
}: GenerateProcedureFileArgs): string {
  const mod = DIALECT_MODULES[dialect];
  if (!mod) return "";
  const occ = opts?.useOptimisticConcurrency === true;
  for (const t of tables) {
    if (!tableHasAuditColumns(t, { useOptimisticConcurrency: occ })) {
      throw new Error(
        `cannot generate procs for ${t.entityName}: requires audit columns`,
      );
    }
  }

  const perEntityBlocks = tables.map((t) => ({
    entityName: t.entityName,
    stmts: generateProceduresFor(mod, t, {
      byFields: byFieldsByEntity.get(t.entityName) ?? [],
      useOptimisticConcurrency: occ,
      idType: opts?.idType,
    }),
  }));

  const inner = perEntityBlocks
    .map(({ entityName, stmts }) => [`-- ${entityName}`, ...stmts].join("\n\n"))
    .join("\n\n");
  return `${inner}\n`;
}

/** The routine names `generateProcedureFile` will write for the same (dialect, tables, byFields, opts) tuple — the migration generator builds matching DROP statements from these for the `down` migration so a migrate-up/migrate-down round-trips cleanly. Names + order come from the shared `procedureSpecs`, the same source the per-dialect fan-out uses, so the two can't drift. */
export function listProcedureNames({
  dialect,
  tables,
  byFieldsByEntity,
  opts,
}: GenerateProcedureFileArgs): RoutineName[] {
  const kind = ROUTINE_KIND_BY_DIALECT[dialect];
  if (!kind) return [];
  const occ = opts?.useOptimisticConcurrency === true;
  const out: RoutineName[] = [];
  for (const t of tables) {
    const byFields = byFieldsByEntity.get(t.entityName) ?? [];
    for (const spec of procedureSpecs(t.entityName, { byFields, occ })) {
      out.push({ kind, name: spec.name });
    }
  }
  return out;
}
