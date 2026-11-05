import type { Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  entityUsesOptimisticConcurrency,
  mappedTableNameForEntity,
  normalizeDialect,
  normalizeTable,
  SQL_DIALECTS,
  type SchemaData,
  type SqlDialect,
} from "../../lib/generate-sql.ts";
import { effectiveTableName } from "../../lib/effective-table-name.ts";

interface SkipEntity {
  entityName: string;
  physicalTable: string;
  acceptableLower: Set<string>;
  usesOptimisticConcurrency: boolean;
}

interface CoverageGap {
  entityName: string;
  physicalTable: string;
  dialect: string;
  expectedDir: string;
}

interface CoverageGapInput {
  entities: SkipEntity[];
  dialects: SqlDialect[];
  coveredByDialect: Map<string, Set<string>>;
  deterministicDir: string;
}

interface AssertCoverageInput {
  datasourceData?: unknown;
  deterministicDir?: unknown;
  dialects?: unknown;
  extraCoverageSqlByDialect?: Record<string, string[]>;
  useOptimisticConcurrency?: boolean;
}

interface OccColumnGap {
  entityName: string;
  physicalTable: string;
  dialect: string;
}

// The canonical SQL dialect set (lowercased), derived from the one source of truth in generate-sql.mjs — never a hand-maintained second copy.
const CUSTOM_DIALECTS: SqlDialect[] = SQL_DIALECTS.map(
  (d) => normalizeDialect(d)!,
);

// why: strip SQL comments (-- line / /* block */) so commented-out CREATE TABLE doesn't false-positive as coverage.
function stripSqlComments(sql: string): string {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
}

const CREATE_TABLE_NAME_RE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?/gi;

// why: collect every table the user's custom SQL strings already CREATE — case-insensitive, quoted-or-unquoted, comments ignored.
function collectCoveredTables(customSqlList: unknown): Set<string> {
  const covered = new Set<string>();
  if (!Array.isArray(customSqlList)) return covered;
  for (const sql of customSqlList) {
    if (typeof sql !== "string") continue;
    const stripped = stripSqlComments(sql);
    let m: RegExpExecArray | null;
    CREATE_TABLE_NAME_RE.lastIndex = 0;
    while ((m = CREATE_TABLE_NAME_RE.exec(stripped)) !== null) {
      covered.add(m[1].toLowerCase());
    }
  }
  return covered;
}

// why: the parenthesised column body of the first CREATE TABLE whose name is in `names` — paren-depth matched so a type like DECIMAL(10,2) doesn't truncate it. Null when the table isn't created in this SQL.
function createTableBodyFor(sql: string, names: Set<string>): string | null {
  const stripped = stripSqlComments(sql);
  CREATE_TABLE_NAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CREATE_TABLE_NAME_RE.exec(stripped)) !== null) {
    if (!names.has(m[1].toLowerCase())) continue;
    const open = stripped.indexOf("(", m.index + m[0].length);
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < stripped.length; i++) {
      if (stripped[i] === "(") depth++;
      else if (stripped[i] === ")" && --depth === 0)
        return stripped.slice(open + 1, i);
    }
  }
  return null;
}

const UPDATED_COLUMN_RE = /[(,]\s*["`\[]?updated["`\]]?\s/i;

// why: does any dialect's custom DDL for this table declare an `updated` column — the OCC row-version token the router reads. Prepend `(` so a leading `updated` column is detected too.
function customDdlHasUpdatedColumn(
  ent: SkipEntity,
  sqlList: string[],
): boolean {
  for (const sql of sqlList) {
    if (typeof sql !== "string") continue;
    const body = createTableBodyFor(sql, ent.acceptableLower);
    if (body !== null && UPDATED_COLUMN_RE.test(`(${body}`)) return true;
  }
  return false;
}

// why: read every <dialect>/*_up.sql under the supplied custom-migrations dir; missing dir/dialect → empty array per dialect. Non-directory at root throws so the caller can surface a misconfigured path.
async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function loadCustomMigrationsByDialect(
  customDir: string,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const dialect of CUSTOM_DIALECTS) out[dialect] = [];
  if (!customDir) return out;
  const absDir = resolve(customDir);
  const rootStat = await statOrNull(absDir);
  if (!rootStat) return out;
  if (!rootStat.isDirectory()) {
    throw new Error(
      `loadCustomMigrationsByDialect: ${absDir} exists but is not a directory`,
    );
  }
  for (const dialect of CUSTOM_DIALECTS) {
    const sub = join(absDir, dialect);
    const subStat = await statOrNull(sub);
    if (!subStat || !subStat.isDirectory()) continue;
    const ups = (await readdir(sub)).filter((f) => f.endsWith("_up.sql"));
    out[dialect] = await Promise.all(
      ups.map((f) => readFile(join(sub, f), "utf8")),
    );
  }
  return out;
}

interface BuildSkipEntityArgs {
  data: SchemaData;
  entry: SchemaData["types"][number];
  entityName: string;
  globalOptimisticConcurrency: boolean;
}

function buildSkipEntity({
  data,
  entry,
  entityName,
  globalOptimisticConcurrency,
}: BuildSkipEntityArgs): SkipEntity {
  const mapped = mappedTableNameForEntity(data, entityName);
  const normalized = normalizeTable(entry, {
    pluralizeTableNames: false,
    data,
  });
  const singular = normalized.name;
  const plural = effectiveTableName(singular, true);
  const physical = mapped ?? singular;
  return {
    entityName,
    physicalTable: physical,
    acceptableLower: new Set(
      [physical, singular, plural, entityName]
        .filter((s) => typeof s === "string" && s.length > 0)
        .map((s) => s.toLowerCase()),
    ),
    usesOptimisticConcurrency: entityUsesOptimisticConcurrency(
      normalized,
      globalOptimisticConcurrency,
    ),
  };
}

function collectSkipMigrationsEntities(
  datasourceData: unknown,
  globalOptimisticConcurrency = false,
): SkipEntity[] {
  if (
    datasourceData === null ||
    datasourceData === undefined ||
    typeof datasourceData !== "object"
  ) {
    throw new Error(
      "assertSkipMigrationsCovered: datasourceData must be a parsed datasource_types object",
    );
  }
  const data = datasourceData as SchemaData;
  const types = Array.isArray(data.types) ? data.types : [];
  const out: SkipEntity[] = [];
  for (const entry of types) {
    if (entry === null || typeof entry !== "object") continue;
    const keys = Object.keys(entry);
    if (keys.length !== 1) continue;
    const entityName = keys[0];
    const body = entry[entityName];
    if (body === null || typeof body !== "object") continue;
    if (body.skip_migrations !== true) continue;
    out.push(
      buildSkipEntity({
        data,
        entry,
        entityName,
        globalOptimisticConcurrency,
      }),
    );
  }
  return out;
}

function normalizeTargetDialects(dialects: unknown): SqlDialect[] {
  if (!Array.isArray(dialects)) {
    throw new Error(
      "assertSkipMigrationsCovered: dialects must be an array of dialect keys",
    );
  }
  return dialects.map((d) => {
    const key = normalizeDialect(d);
    if (!key) {
      throw new Error(
        `assertSkipMigrationsCovered: unknown SQL dialect "${d}". Valid: ${SQL_DIALECTS.join(", ")}.`,
      );
    }
    return key;
  });
}

function collectCoverageGaps({
  entities,
  dialects,
  coveredByDialect,
  deterministicDir,
}: CoverageGapInput): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const ent of entities) {
    for (const dialect of dialects) {
      const covered = coveredByDialect.get(dialect);
      const hit = [...ent.acceptableLower].some((n) => covered!.has(n));
      if (!hit) {
        gaps.push({
          entityName: ent.entityName,
          physicalTable: ent.physicalTable,
          dialect,
          expectedDir: join(resolve(deterministicDir), "custom", dialect),
        });
      }
    }
  }
  return gaps;
}

function coverageGapError(gaps: CoverageGap[]): Error {
  const lines = [
    `skip_migrations coverage gap: ${gaps.length} (entity, dialect) pair(s) need hand-authored custom SQL.`,
    "Every entity with `skip_migrations: true` must have a covering CREATE TABLE in deterministic/custom/<dialect>/*_up.sql for each dialect the project targets.",
    "",
  ];
  for (const g of gaps) {
    lines.push(
      `  - entity "${g.entityName}" (physical table "${g.physicalTable}") is uncovered for dialect "${g.dialect}".`,
    );
    lines.push(`      expected: ${g.expectedDir}/<NNN>_${g.entityName}_up.sql`);
  }
  return new Error(lines.join("\n"));
}

function collectOccColumnGaps({
  entities,
  dialects,
  sqlByDialect,
  extraCoverageSqlByDialect,
}: {
  entities: SkipEntity[];
  dialects: SqlDialect[];
  sqlByDialect: Record<string, string[]>;
  extraCoverageSqlByDialect: Record<string, string[]>;
}): OccColumnGap[] {
  const gaps: OccColumnGap[] = [];
  for (const ent of entities) {
    if (!ent.usesOptimisticConcurrency) continue;
    for (const dialect of dialects) {
      const sqlList = [
        ...(sqlByDialect[dialect] ?? []),
        ...(extraCoverageSqlByDialect[dialect] ?? []),
      ];
      if (!customDdlHasUpdatedColumn(ent, sqlList)) {
        gaps.push({
          entityName: ent.entityName,
          physicalTable: ent.physicalTable,
          dialect,
        });
      }
    }
  }
  return gaps;
}

function occColumnGapError(gaps: OccColumnGap[]): Error {
  const lines = [
    `optimistic-concurrency integrity: ${gaps.length} skip_migrations (entity, dialect) pair(s) are OCC-enabled but their custom DDL has no "updated" row-version column.`,
    "Under use_optimistic_concurrency the router requires If-Match: <updated>, so the table must declare an `updated` column. For a skip_migrations table the migration generator does not add it — the hand-authored custom DDL must.",
    "Fix each: add an `updated` column to the custom CREATE TABLE, or set `use_optimistic_concurrency: false` on the datasource_type to opt it out of OCC.",
    "",
  ];
  for (const g of gaps) {
    lines.push(
      `  - entity "${g.entityName}" (physical table "${g.physicalTable}"), dialect "${g.dialect}".`,
    );
  }
  return new Error(lines.join("\n"));
}

// why: target-aware coverage assertion — only enforces the dialects passed in. Aggregates all (entity, dialect) gaps before throwing so the author sees the full list in one pass. `extraCoverageSqlByDialect` ({ [dialect]: [upSql] }) counts CREATE TABLEs supplied by included datasources, whose custom SQL is not in this project's `custom/` folder.
export async function assertSkipMigrationsCovered({
  datasourceData,
  deterministicDir,
  dialects,
  extraCoverageSqlByDialect = {},
  useOptimisticConcurrency = false,
}: AssertCoverageInput = {}): Promise<void> {
  if (typeof deterministicDir !== "string" || deterministicDir.length === 0) {
    throw new Error(
      "assertSkipMigrationsCovered: deterministicDir must be a non-empty string",
    );
  }
  const normalizedDialects = normalizeTargetDialects(dialects);
  if (normalizedDialects.length === 0) return;

  const entities = collectSkipMigrationsEntities(
    datasourceData,
    useOptimisticConcurrency === true,
  );
  if (entities.length === 0) return;

  const customDir = join(resolve(deterministicDir), "custom");
  const sqlByDialect = await loadCustomMigrationsByDialect(customDir);

  const coveredByDialect = new Map<string, Set<string>>();
  for (const dialect of normalizedDialects) {
    coveredByDialect.set(
      dialect,
      collectCoveredTables([
        ...(sqlByDialect[dialect] ?? []),
        ...(extraCoverageSqlByDialect[dialect] ?? []),
      ]),
    );
  }

  const gaps = collectCoverageGaps({
    entities,
    dialects: normalizedDialects,
    coveredByDialect,
    deterministicDir,
  });
  if (gaps.length > 0) throw coverageGapError(gaps);

  const occGaps = collectOccColumnGaps({
    entities,
    dialects: normalizedDialects,
    sqlByDialect,
    extraCoverageSqlByDialect,
  });
  if (occGaps.length > 0) throw occColumnGapError(occGaps);
}
