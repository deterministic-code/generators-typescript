import {
  supportsProcedures,
  tableHasAuditColumns,
} from "../../lib/generate-sql.ts";
import type { SqlDialect, NormalizedTable } from "../../lib/generate-sql.ts";
import {
  generateProcedureFile,
  listProcedureNames,
} from "../../lib/generate-procedures.ts";

export interface SpOpts {
  enabled: boolean;
  useOptimisticConcurrency?: boolean;
  byFieldsByEntity?: Map<string, string[]>;
  idType?: string;
}

interface StoredProcedureArgs {
  dialect: SqlDialect;
  liveTables: NormalizedTable[];
  spOpts: SpOpts;
}

interface StoredProcedureSections {
  up: string[];
  down: string[];
}

export function generateStoredProcedureSections({
  dialect,
  liveTables,
  spOpts,
}: StoredProcedureArgs): StoredProcedureSections {
  if (spOpts.enabled !== true) return { up: [], down: [] };
  if (!supportsProcedures(dialect)) return { up: [], down: [] };

  const tablesForProcs = liveTables.filter((t) =>
    tableHasAuditColumns(t, {
      useOptimisticConcurrency: spOpts.useOptimisticConcurrency === true,
    }),
  );
  if (tablesForProcs.length === 0) return { up: [], down: [] };

  const byFields = spOpts.byFieldsByEntity ?? new Map<string, string[]>();
  const occ = spOpts.useOptimisticConcurrency === true;

  const procText = generateProcedureFile({
    dialect,
    tables: tablesForProcs,
    byFieldsByEntity: byFields,
    opts: { useOptimisticConcurrency: occ, idType: spOpts.idType },
  });
  const names = listProcedureNames({
    dialect,
    tables: tablesForProcs,
    byFieldsByEntity: byFields,
    opts: { useOptimisticConcurrency: occ },
  });

  const up = ["-- Stored procedures", procText.trimEnd()];
  const drops = names.map((n) => {
    const verb = n.kind === "function" ? "FUNCTION" : "PROCEDURE";
    return `DROP ${verb} IF EXISTS ${n.name};`;
  });
  const down = ["-- DROP stored procedures", ...drops, ""];
  return { up, down };
}
