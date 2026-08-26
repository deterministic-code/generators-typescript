import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathExists } from "../repositories/pathExists";
import { normalizeDialect, q, type SqlDialect } from "./sql-dialect";
import type { Connection as MysqlConnection } from "mysql2/promise";
import type { Request as MssqlRequest } from "mssql";

export { normalizeDialect };

type MigrationRowValue = string | number | bigint | boolean | Date | null;
type MigrationRow = Record<string, MigrationRowValue>;
type MigrationSqlParam = string | number | bigint | boolean | Date | null;

/** The subset of a better-sqlite3 Database that `insertLogStarted` reaches through `_raw` when a caller injects a synchronous handle. */
interface SqliteRawDatabase {
  prepare(source: string): {
    run(...params: MigrationSqlParam[]): { lastInsertRowid: number | bigint };
  };
}

/** Provider-agnostic migration client: the exact methods `runUp`/`runDown`/`setupSql` execution paths call, honored identically by every dialect adapter. */
export interface MigrationClient {
  dialect: SqlDialect;
  exec(sql: string): Promise<void>;
  query(sql: string, params?: MigrationSqlParam[]): Promise<MigrationRow[]>;
  run(sql: string, params?: MigrationSqlParam[]): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
  _raw?: SqliteRawDatabase;
}

/** Programmatic Oracle credentials, the object form `parseOracleConnection` accepts alongside a `user/password@connectString` string. */
interface OracleConnectionConfig {
  user: string;
  password: string;
  connectString: string;
}

/** One discovered migration: its up script and the rollback sibling when present. */
export interface MigrationDescriptor {
  name: string;
  upPath: string;
  downPath: string | null;
}

const ROLLBACK_PREFIX = "rollback_";
const UP_SUFFIX = "_up.sql";
const DOWN_SUFFIX = "_down.sql";

export async function discoverMigrations({
  migratePath,
  dialect,
}: {
  migratePath: string;
  dialect: string;
}): Promise<MigrationDescriptor[]> {
  const key = requireDialect(dialect);
  if (!migratePath || !(await pathExists(migratePath))) return [];

  const allFiles = await listSqlFilesRecursive(migratePath);
  const { ups, downsByUpPath } = classifyMigrationFiles(allFiles, key);

  ups.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return ups.map(({ file, name }) => ({
    name,
    upPath: file,
    downPath: downsByUpPath.get(file) ?? null,
  }));
}

interface ClassifiedMigrationFiles {
  ups: { file: string; name: string }[];
  downsByUpPath: Map<string, string>;
}

type FileClassification =
  | { role: "up"; name: string }
  | { role: "down"; upPath: string }
  | null;

function classifyMigrationFile(
  file: string,
  key: SqlDialect,
): FileClassification {
  const base = basename(file);
  if (base.endsWith(DOWN_SUFFIX)) {
    const stem = base.slice(0, -DOWN_SUFFIX.length);
    return {
      role: "down",
      upPath: file.slice(0, -base.length) + `${stem}${UP_SUFFIX}`,
    };
  }
  if (base.endsWith(UP_SUFFIX)) {
    return { role: "up", name: base.slice(0, -UP_SUFFIX.length) };
  }
  if (base.startsWith(ROLLBACK_PREFIX)) {
    return {
      role: "down",
      upPath: file.slice(0, -base.length) + base.slice(ROLLBACK_PREFIX.length),
    };
  }
  if (base === `migration.${key}.sql`) {
    return { role: "up", name: basename(dirname(file)) };
  }
  if (base.endsWith(`.${key}.sql`)) return { role: "up", name: base };
  return null;
}

function classifyMigrationFiles(
  allFiles: string[],
  key: SqlDialect,
): ClassifiedMigrationFiles {
  const ups: { file: string; name: string }[] = [];
  const downsByUpPath = new Map<string, string>();
  for (const file of allFiles) {
    const c = classifyMigrationFile(file, key);
    if (c === null) continue;
    if (c.role === "up") ups.push({ file, name: c.name });
    else downsByUpPath.set(c.upPath, file);
  }
  return { ups, downsByUpPath };
}

async function listSqlFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith(".sql")) {
        out.push(full);
      }
    }
  }
  return out;
}

export function setupSql(dialect: string): string[] {
  const key = requireDialect(dialect);
  switch (key) {
    case "sqlite":
      return [sqliteMigratesDdl(), sqliteMigrateLogsDdl()];
    case "postgres":
      return [postgresMigratesDdl(), postgresMigrateLogsDdl()];
    case "mysql":
      return [mysqlMigratesDdl(), mysqlMigrateLogsDdl()];
    case "sqlserver":
      return [sqlserverMigratesDdl(), sqlserverMigrateLogsDdl()];
    case "oracle":
      return [oracleMigratesDdl(), oracleMigrateLogsDdl()];
    default:
      throw new Error(`Unhandled dialect: ${key}`);
  }
}

function sqliteMigratesDdl(): string {
  return `CREATE TABLE IF NOT EXISTS ${q("sqlite", "migrates")} (
  ${q("sqlite", "id")} INTEGER PRIMARY KEY AUTOINCREMENT,
  ${q("sqlite", "name")} VARCHAR(255) NOT NULL UNIQUE,
  ${q("sqlite", "checksum")} VARCHAR(64),
  ${q("sqlite", "created")} DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ${q("sqlite", "updated")} DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);`;
}
function sqliteMigrateLogsDdl(): string {
  return `CREATE TABLE IF NOT EXISTS ${q("sqlite", "migrate_logs")} (
  ${q("sqlite", "id")} INTEGER PRIMARY KEY AUTOINCREMENT,
  ${q("sqlite", "migrate_name")} VARCHAR(255) NOT NULL,
  ${q("sqlite", "direction")} VARCHAR(8) NOT NULL,
  ${q("sqlite", "status")} VARCHAR(16) NOT NULL,
  ${q("sqlite", "finished_at")} DATETIME,
  ${q("sqlite", "duration_ms")} INTEGER,
  ${q("sqlite", "error_message")} TEXT,
  ${q("sqlite", "created")} DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ${q("sqlite", "updated")} DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);`;
}

function postgresMigratesDdl(): string {
  return `CREATE TABLE IF NOT EXISTS ${q("postgres", "migrates")} (
  ${q("postgres", "id")} BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ${q("postgres", "name")} VARCHAR(255) NOT NULL UNIQUE,
  ${q("postgres", "checksum")} VARCHAR(64),
  ${q("postgres", "created")} TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ${q("postgres", "updated")} TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;
}
function postgresMigrateLogsDdl(): string {
  return `CREATE TABLE IF NOT EXISTS ${q("postgres", "migrate_logs")} (
  ${q("postgres", "id")} BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ${q("postgres", "migrate_name")} VARCHAR(255) NOT NULL,
  ${q("postgres", "direction")} VARCHAR(8) NOT NULL,
  ${q("postgres", "status")} VARCHAR(16) NOT NULL,
  ${q("postgres", "finished_at")} TIMESTAMPTZ,
  ${q("postgres", "duration_ms")} INTEGER,
  ${q("postgres", "error_message")} TEXT,
  ${q("postgres", "created")} TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ${q("postgres", "updated")} TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;
}

function mysqlMigratesDdl(): string {
  return `CREATE TABLE IF NOT EXISTS ${q("mysql", "migrates")} (
  ${q("mysql", "id")} BIGINT AUTO_INCREMENT PRIMARY KEY,
  ${q("mysql", "name")} VARCHAR(255) NOT NULL UNIQUE,
  ${q("mysql", "checksum")} VARCHAR(64),
  ${q("mysql", "created")} TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ${q("mysql", "updated")} TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);`;
}
function mysqlMigrateLogsDdl(): string {
  return `CREATE TABLE IF NOT EXISTS ${q("mysql", "migrate_logs")} (
  ${q("mysql", "id")} BIGINT AUTO_INCREMENT PRIMARY KEY,
  ${q("mysql", "migrate_name")} VARCHAR(255) NOT NULL,
  ${q("mysql", "direction")} VARCHAR(8) NOT NULL,
  ${q("mysql", "status")} VARCHAR(16) NOT NULL,
  ${q("mysql", "finished_at")} TIMESTAMP NULL,
  ${q("mysql", "duration_ms")} INT,
  ${q("mysql", "error_message")} TEXT,
  ${q("mysql", "created")} TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ${q("mysql", "updated")} TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);`;
}

function sqlserverMigratesDdl(): string {
  return `IF OBJECT_ID('dbo.migrates', 'U') IS NULL
CREATE TABLE ${q("sqlserver", "migrates")} (
  ${q("sqlserver", "id")} BIGINT IDENTITY(1,1) PRIMARY KEY,
  ${q("sqlserver", "name")} NVARCHAR(255) NOT NULL UNIQUE,
  ${q("sqlserver", "checksum")} NVARCHAR(64),
  ${q("sqlserver", "created")} DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  ${q("sqlserver", "updated")} DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);`;
}
function sqlserverMigrateLogsDdl(): string {
  return `IF OBJECT_ID('dbo.migrate_logs', 'U') IS NULL
CREATE TABLE ${q("sqlserver", "migrate_logs")} (
  ${q("sqlserver", "id")} BIGINT IDENTITY(1,1) PRIMARY KEY,
  ${q("sqlserver", "migrate_name")} NVARCHAR(255) NOT NULL,
  ${q("sqlserver", "direction")} NVARCHAR(8) NOT NULL,
  ${q("sqlserver", "status")} NVARCHAR(16) NOT NULL,
  ${q("sqlserver", "finished_at")} DATETIME2,
  ${q("sqlserver", "duration_ms")} INT,
  ${q("sqlserver", "error_message")} NVARCHAR(MAX),
  ${q("sqlserver", "created")} DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  ${q("sqlserver", "updated")} DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);`;
}

function oracleMigratesDdl(): string {
  return `BEGIN
  EXECUTE IMMEDIATE 'CREATE TABLE ${q("oracle", "migrates")} (
    ${q("oracle", "id")} NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${q("oracle", "name")} VARCHAR2(255) NOT NULL UNIQUE,
    ${q("oracle", "checksum")} VARCHAR2(64),
    ${q("oracle", "created")} TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ${q("oracle", "updated")} TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
END;`;
}
function oracleMigrateLogsDdl(): string {
  return `BEGIN
  EXECUTE IMMEDIATE 'CREATE TABLE ${q("oracle", "migrate_logs")} (
    ${q("oracle", "id")} NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${q("oracle", "migrate_name")} VARCHAR2(255) NOT NULL,
    ${q("oracle", "direction")} VARCHAR2(8) NOT NULL,
    ${q("oracle", "status")} VARCHAR2(16) NOT NULL,
    ${q("oracle", "finished_at")} TIMESTAMP,
    ${q("oracle", "duration_ms")} NUMBER(10),
    ${q("oracle", "error_message")} CLOB,
    ${q("oracle", "created")} TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ${q("oracle", "updated")} TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
END;`;
}

/** Strip pre-refactor `-- deterministic-content-hash: <sha>` header if present so upgrading users carrying the legacy header keep the same checksum migrate:up recorded. */
const LEGACY_HEADER_RE =
  /^(?:\/\/|--|#)\s+deterministic-content-hash:\s+[0-9a-f]{64}\s*\r?\n?/;

export function checksum(text: string): string {
  const body = text.replace(LEGACY_HEADER_RE, "");
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export async function readSqlStatements(filePath: string): Promise<string[]> {
  const text = await readFile(filePath, "utf8");
  return parseSqlStatements(text);
}

const isSqlWordBoundary = (ch: string | undefined): boolean =>
  ch === undefined || !/[A-Za-z0-9_]/.test(ch);

function matchDollarTag(text: string, startIdx: number): string | null {
  if (text[startIdx] !== "$") return null;
  if (text[startIdx + 1] === "$") return "";
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)\$/.exec(text.slice(startIdx));
  return m ? m[1] : null;
}

/** End index of a whole-line `GO` batch separator at line-start position `i`, or -1 when that line is not a bare `GO`. */
function wholeLineGoEnd(text: string, i: number): number {
  const eol = text.indexOf("\n", i);
  const lineEnd = eol === -1 ? text.length : eol;
  return /^\s*GO\s*$/i.test(text.slice(i, lineEnd)) ? lineEnd : -1;
}

interface SqlScanState {
  stmts: string[];
  buf: string;
  inSingle: boolean;
  inLineComment: boolean;
  inBlockComment: boolean;
  beginDepth: number;
  dollarTag: string | null;
}

function consumeDollarBody(text: string, i: number, st: SqlScanState): number {
  const closer = `$${st.dollarTag}$`;
  if (text.slice(i, i + closer.length) === closer) {
    st.buf += closer;
    st.dollarTag = null;
    return i + closer.length - 1;
  }
  st.buf += text[i];
  return i;
}

function consumeBlockComment(
  text: string,
  i: number,
  st: SqlScanState,
): number {
  st.buf += text[i];
  if (text[i] === "*" && text[i + 1] === "/") {
    st.buf += text[i + 1];
    st.inBlockComment = false;
    return i + 1;
  }
  return i;
}

function consumeSingleQuote(text: string, i: number, st: SqlScanState): number {
  const c = text[i];
  st.buf += c;
  if (c === "'") {
    if (text[i + 1] === "'") {
      st.buf += text[i + 1];
      return i + 1;
    }
    st.inSingle = false;
  }
  return i;
}

/** Consume one char while inside an open dollar-quote / comment / single-quote region, appending to `st.buf`. Returns the new index, or -1 when no region is open. */
function consumeOpenSqlRegion(
  text: string,
  i: number,
  st: SqlScanState,
): number {
  if (st.dollarTag !== null) return consumeDollarBody(text, i, st);
  if (st.inLineComment) {
    st.buf += text[i];
    if (text[i] === "\n") st.inLineComment = false;
    return i;
  }
  if (st.inBlockComment) return consumeBlockComment(text, i, st);
  if (st.inSingle) return consumeSingleQuote(text, i, st);
  return -1;
}

function openDollarQuote(text: string, i: number, st: SqlScanState): number {
  const tag = matchDollarTag(text, i);
  if (tag === null) return -1;
  const opener = `$${tag}$`;
  st.buf += opener;
  st.dollarTag = tag;
  return i + opener.length - 1;
}

/** Open a dollar-quote / line-comment / block-comment / single-quote region starting at `i`. Returns the new index, or -1 when nothing opens here. */
function openSqlRegion(text: string, i: number, st: SqlScanState): number {
  const c = text[i];
  const next = text[i + 1];
  if (c === "-" && next === "-") {
    st.buf += c;
    st.inLineComment = true;
    return i;
  }
  if (c === "/" && next === "*") {
    st.buf += c;
    st.inBlockComment = true;
    return i;
  }
  if (c === "'") {
    st.inSingle = true;
    st.buf += c;
    return i;
  }
  if (c === "$") return openDollarQuote(text, i, st);
  return -1;
}

/** Track `BEGIN…END` nesting so a `;` inside a routine body doesn't end the statement. Returns the new index, or -1 when `i` is not at a BEGIN/END keyword. */
function consumeBeginEnd(text: string, i: number, st: SqlScanState): number {
  const c = text[i];
  if ((c === "B" || c === "b") && isSqlWordBoundary(text[i - 1])) {
    if (
      /^begin/i.test(text.slice(i, i + 5)) &&
      isSqlWordBoundary(text[i + 5])
    ) {
      st.beginDepth++;
      st.buf += text.slice(i, i + 5);
      return i + 4;
    }
  }
  if ((c === "E" || c === "e") && isSqlWordBoundary(text[i - 1])) {
    if (
      /^end/i.test(text.slice(i, i + 3)) &&
      isSqlWordBoundary(text[i + 3]) &&
      st.beginDepth > 0
    ) {
      st.beginDepth--;
      st.buf += text.slice(i, i + 3);
      return i + 2;
    }
  }
  return -1;
}

function flushStatement(st: SqlScanState): void {
  const s = st.buf.trim();
  if (s.length > 0) st.stmts.push(s);
  st.buf = "";
}

/** Advance the scan by one char: consume an open region, honor a whole-line `GO`, open a region, track `BEGIN…END`, split on a top-level `;`, else buffer the char. Returns the index to resume from (the loop's `i++` moves past it). */
function scanSqlChar(text: string, i: number, st: SqlScanState): number {
  const consumed = consumeOpenSqlRegion(text, i, st);
  if (consumed !== -1) return consumed;
  if (i === 0 || text[i - 1] === "\n") {
    const goEnd = wholeLineGoEnd(text, i);
    if (goEnd !== -1) {
      flushStatement(st);
      st.beginDepth = 0;
      return goEnd;
    }
  }
  const opened = openSqlRegion(text, i, st);
  if (opened !== -1) return opened;
  const be = consumeBeginEnd(text, i, st);
  if (be !== -1) return be;
  if (text[i] === ";" && st.beginDepth === 0) {
    flushStatement(st);
    return i;
  }
  st.buf += text[i];
  return i;
}

export function parseSqlStatements(text: string): string[] {
  const st: SqlScanState = {
    stmts: [],
    buf: "",
    inSingle: false,
    inLineComment: false,
    inBlockComment: false,
    beginDepth: 0,
    dollarTag: null,
  };
  for (let i = 0; i < text.length; i++) {
    i = scanSqlChar(text, i, st);
  }
  flushStatement(st);
  return st.stmts;
}

export async function createClient({
  provider,
  connection,
}: {
  provider: string;
  connection: string;
}): Promise<MigrationClient> {
  const key = requireDialect(provider);
  switch (key) {
    case "sqlite":
      return createSqliteClient(connection);
    case "postgres":
      return createPostgresClient(connection);
    case "mysql":
      return createMysqlClient(connection);
    case "sqlserver":
      return createSqlServerClient(connection);
    case "oracle":
      return createOracleClient(connection);
    default:
      throw new Error(`Unhandled provider: ${key}`);
  }
}

async function createSqliteClient(
  connection: string,
): Promise<MigrationClient> {
  if (!connection) throw new Error("sqlite requires a database file path");
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(connection);
  return {
    dialect: "sqlite",
    async exec(sql) {
      db.exec(sql);
    },
    async query(sql, params = []) {
      const stmt = db.prepare<MigrationSqlParam[], MigrationRow>(sql);
      try {
        return stmt.all(...params);
      } catch {
        stmt.run(...params);
        return [];
      }
    },
    async run(sql, params = []) {
      db.prepare(sql).run(...params);
    },
    async transaction(fn) {
      db.exec("BEGIN");
      try {
        const r = await fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch (rollbackErr) {
          console.warn(
            "sqlite ROLLBACK failed after transaction error; original error rethrown",
            rollbackErr,
          );
        }
        throw e;
      }
    },
    async close() {
      db.close();
    },
  };
}

async function createPostgresClient(
  connection: string,
): Promise<MigrationClient> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: connection });
  await client.connect();
  return {
    dialect: "postgres",
    async exec(sql) {
      await client.query(sql);
    },
    async query(sql, params = []) {
      const r = await client.query(
        translatePlaceholders("postgres", sql),
        params,
      );
      return r.rows;
    },
    async run(sql, params = []) {
      await client.query(translatePlaceholders("postgres", sql), params);
    },
    async transaction(fn) {
      await client.query("BEGIN");
      try {
        const r = await fn();
        await client.query("COMMIT");
        return r;
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          console.warn(
            "postgres ROLLBACK failed after transaction error; original error rethrown",
            rollbackErr,
          );
        }
        throw e;
      }
    },
    async close() {
      await client.end();
    },
  };
}

export async function applyMysqlDdlViaTextProtocol(
  conn: Pick<MysqlConnection, "query">,
  sql: string,
): Promise<void> {
  // why: DDL statements (DROP/CREATE PROCEDURE) reject prepared-statement protocol (MySQL 1295)
  await conn.query(sql);
}
// TODO(phase-5-followup): Rust sqlx must use Executor::execute_many or query_unprepared for DDL

async function createMysqlClient(connection: string): Promise<MigrationClient> {
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection(connection);
  return {
    dialect: "mysql",
    async exec(sql) {
      await applyMysqlDdlViaTextProtocol(conn, sql);
    },
    async query(sql, params = []) {
      const [rows] = await conn.execute(sql, params);
      return rows as MigrationRow[];
    },
    async run(sql, params = []) {
      await conn.execute(sql, params);
    },
    async transaction(fn) {
      await conn.beginTransaction();
      try {
        const r = await fn();
        await conn.commit();
        return r;
      } catch (e) {
        try {
          await conn.rollback();
        } catch (rollbackErr) {
          console.warn(
            "mysql rollback failed after transaction error; original error rethrown",
            rollbackErr,
          );
        }
        throw e;
      }
    },
    async close() {
      await conn.end();
    },
  };
}

async function createSqlServerClient(
  connection: string,
): Promise<MigrationClient> {
  const mssql = (await import("mssql")).default ?? (await import("mssql"));
  const pool = await mssql.connect(connection);
  return {
    dialect: "sqlserver",
    async exec(sql) {
      await pool.request().batch(sql);
    },
    async query(sql, params = []) {
      const req = pool.request();
      const translated = bindMssql(req, sql, params);
      const r = await req.query(translated);
      return r.recordset ?? [];
    },
    async run(sql, params = []) {
      const req = pool.request();
      const translated = bindMssql(req, sql, params);
      await req.query(translated);
    },
    async transaction(fn) {
      const tx = pool.transaction();
      await tx.begin();
      try {
        const r = await fn();
        await tx.commit();
        return r;
      } catch (e) {
        try {
          await tx.rollback();
        } catch (rollbackErr) {
          console.warn(
            "sqlserver rollback failed after transaction error; original error rethrown",
            rollbackErr,
          );
        }
        throw e;
      }
    },
    async close() {
      await pool.close();
    },
  };
}

async function createOracleClient(
  connection: string,
): Promise<MigrationClient> {
  const oracledb =
    (await import("oracledb")).default ?? (await import("oracledb"));
  const conn = await oracledb.getConnection(parseOracleConnection(connection));
  return {
    dialect: "oracle",
    async exec(sql) {
      await conn.execute(sql, [], { autoCommit: true });
    },
    async query(sql, params = []) {
      const r = await conn.execute<MigrationRow>(
        translatePlaceholders("oracle", sql),
        params,
        {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        },
      );
      return (r.rows ?? []).map(lowercaseKeys);
    },
    async run(sql, params = []) {
      await conn.execute(translatePlaceholders("oracle", sql), params, {
        autoCommit: false,
      });
    },
    async transaction(fn) {
      try {
        const r = await fn();
        await conn.commit();
        return r;
      } catch (e) {
        try {
          await conn.rollback();
        } catch (rollbackErr) {
          console.warn(
            "oracle rollback failed after transaction error; original error rethrown",
            rollbackErr,
          );
        }
        throw e;
      }
    },
    async close() {
      await conn.close();
    },
  };
}

function lowercaseKeys(row: MigrationRow): MigrationRow {
  const out: MigrationRow = {};
  for (const [k, v] of Object.entries(row)) out[k.toLowerCase()] = v;
  return out;
}

function parseOracleConnection(
  connection: string | OracleConnectionConfig,
): OracleConnectionConfig {
  if (typeof connection === "object" && connection) return connection;
  const m = /^([^/]+)\/([^@]+)@(.+)$/.exec(String(connection));
  if (!m) {
    throw new Error(
      `Oracle connection must look like user/password@connectString`,
    );
  }
  return { user: m[1], password: m[2], connectString: m[3] };
}

function translatePlaceholders(dialect: string, sql: string): string {
  if (dialect === "postgres") {
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
  }
  if (dialect === "oracle") {
    let n = 0;
    return sql.replace(/\?/g, () => `:${++n}`);
  }
  return sql;
}

function bindMssql(
  req: Pick<MssqlRequest, "input">,
  sql: string,
  params: MigrationSqlParam[],
): string {
  let n = 0;
  const translated = sql.replace(/\?/g, () => {
    const name = `p${n}`;
    req.input(name, params[n]);
    n++;
    return `@${name}`;
  });
  return translated;
}

export async function runUp({
  client,
  migrations,
  env = process.env,
}: {
  client: MigrationClient;
  migrations: MigrationDescriptor[];
  env?: NodeJS.ProcessEnv;
}): Promise<{ applied: boolean; name: string | null }> {
  const applied = await appliedRecords(client);
  await assertNoChecksumDrift({ migrations, applied, env });
  const next = migrations.find((m) => !applied.has(m.name));
  if (!next) return { applied: false, name: null };

  const sqlText = await readFile(next.upPath, "utf8");
  const sum = checksum(sqlText);

  const logId = await insertLogStarted(client, next.name, "up");
  const startedAt = Date.now();

  try {
    await client.transaction(async () => {
      const stmts = await readSqlStatements(next.upPath);
      for (const stmt of stmts) {
        await client.exec(stmt);
      }
      await insertMigrate(client, next.name, sum);
    });
  } catch (e) {
    const err = e as Error;
    await updateLogTerminal({
      client,
      id: logId,
      status: "error",
      durationMs: Date.now() - startedAt,
      errorMessage: String(err?.message ?? e),
    });
    throw e;
  }

  await updateLogTerminal({
    client,
    id: logId,
    status: "success",
    durationMs: Date.now() - startedAt,
    errorMessage: null,
  });
  return { applied: true, name: next.name };
}

export async function runDown({
  client,
  migrations,
  env = process.env,
}: {
  client: MigrationClient;
  migrations: MigrationDescriptor[];
  env?: NodeJS.ProcessEnv;
}): Promise<{ rolledBack: boolean; name: string | null }> {
  const applied = await appliedRecords(client);
  await assertNoChecksumDrift({ migrations, applied, env });
  if (applied.size === 0) return { rolledBack: false, name: null };

  const lastApplied = [...migrations]
    .reverse()
    .find((m) => applied.has(m.name));
  if (!lastApplied) {
    throw new Error(
      `Most recently applied migration is not present under --migrate-path`,
    );
  }
  if (!lastApplied.downPath) {
    throw new Error(
      `Cannot roll back "${lastApplied.name}": no rollback_*.sql sibling found`,
    );
  }
  const downPath = lastApplied.downPath;

  const logId = await insertLogStarted(client, lastApplied.name, "down");
  const startedAt = Date.now();

  try {
    await client.transaction(async () => {
      const stmts = await readSqlStatements(downPath);
      for (const stmt of stmts) {
        await client.exec(stmt);
      }
      await deleteMigrate(client, lastApplied.name);
    });
  } catch (e) {
    const err = e as Error;
    await updateLogTerminal({
      client,
      id: logId,
      status: "error",
      durationMs: Date.now() - startedAt,
      errorMessage: String(err?.message ?? e),
    });
    throw e;
  }

  await updateLogTerminal({
    client,
    id: logId,
    status: "success",
    durationMs: Date.now() - startedAt,
    errorMessage: null,
  });
  return { rolledBack: true, name: lastApplied.name };
}

async function appliedRecords(
  client: MigrationClient,
): Promise<Map<string, string | null>> {
  const rows = await client.query(
    `SELECT ${q(client.dialect, "name")} AS name, ${q(client.dialect, "checksum")} AS checksum FROM ${q(client.dialect, "migrates")}`,
  );
  return new Map(
    rows.map(
      (r) =>
        [r.name ?? r.NAME, r.checksum ?? r.CHECKSUM ?? null] as [
          string,
          string | null,
        ],
    ),
  );
}

async function assertNoChecksumDrift({
  migrations,
  applied,
  env = process.env,
}: {
  migrations: MigrationDescriptor[];
  applied: Map<string, string | null>;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (env.MIGRATE_ALLOW_CHECKSUM_DRIFT === "1") return;
  const drifted: { name: string; stored: string; current: string }[] = [];
  for (const m of migrations) {
    if (!applied.has(m.name)) continue;
    const stored = applied.get(m.name);
    if (stored == null) continue;
    const current = checksum(await readFile(m.upPath, "utf8"));
    if (current !== stored) drifted.push({ name: m.name, stored, current });
  }
  if (drifted.length === 0) return;
  const lines = drifted.map(
    (d) =>
      `  ${d.name}: stored ${d.stored.slice(0, 12)}..., current ${d.current.slice(0, 12)}...`,
  );
  throw new Error(
    [
      "Migration checksum drift detected — the migration file changed AFTER it was applied:",
      ...lines,
      "",
      "The DB and source disagree about the schema you're running. Either the codegen",
      "regenerated an already-applied migration in place (the canonical bug — emit a NEW",
      "migration file instead), or the migrate state was hand-edited.",
      "",
      "Recovery options:",
      "  1. Emit a new migration that brings the DB up to the current schema, then deploy.",
      "  2. For showcase/dev DBs with no real data: wipe the DB file and let migrate:up re-run from scratch.",
      "  3. If you've verified the DB matches the new file: MIGRATE_ALLOW_CHECKSUM_DRIFT=1 npm run migrate:up",
    ].join("\n"),
  );
}

async function insertMigrate(
  client: MigrationClient,
  name: string,
  sum: string,
): Promise<void> {
  const t = q(client.dialect, "migrates");
  await client.run(
    `INSERT INTO ${t} (${q(client.dialect, "name")}, ${q(client.dialect, "checksum")}) VALUES (?, ?)`,
    [name, sum],
  );
}

async function deleteMigrate(
  client: MigrationClient,
  name: string,
): Promise<void> {
  const t = q(client.dialect, "migrates");
  await client.run(`DELETE FROM ${t} WHERE ${q(client.dialect, "name")} = ?`, [
    name,
  ]);
}

async function insertLogStarted(
  client: MigrationClient,
  name: string,
  direction: string,
): Promise<MigrationRowValue> {
  const t = q(client.dialect, "migrate_logs");
  if (client.dialect === "sqlite") {
    const stmt = `INSERT INTO ${t} (${q("sqlite", "migrate_name")}, ${q("sqlite", "direction")}, ${q("sqlite", "status")}) VALUES (?, ?, 'started')`;
    const db = client._raw;
    if (db) {
      const info = db.prepare(stmt).run(name, direction);
      return info.lastInsertRowid;
    }
    await client.run(stmt, [name, direction]);
    const rows = await client.query(
      `SELECT ${q("sqlite", "id")} AS id FROM ${t} WHERE ${q("sqlite", "migrate_name")} = ? AND ${q("sqlite", "direction")} = ? ORDER BY id DESC LIMIT 1`,
      [name, direction],
    );
    return rows[0]?.id;
  }
  await client.run(
    `INSERT INTO ${t} (${q(client.dialect, "migrate_name")}, ${q(client.dialect, "direction")}, ${q(client.dialect, "status")}) VALUES (?, ?, 'started')`,
    [name, direction],
  );
  const rows = await client.query(
    `SELECT ${q(client.dialect, "id")} AS id FROM ${t} WHERE ${q(client.dialect, "migrate_name")} = ? AND ${q(client.dialect, "direction")} = ? ORDER BY ${q(client.dialect, "id")} DESC ${limitClause(client.dialect, 1)}`,
    [name, direction],
  );
  return rows[0]?.id ?? rows[0]?.ID;
}

async function updateLogTerminal({
  client,
  id,
  status,
  durationMs,
  errorMessage,
}: {
  client: MigrationClient;
  id: MigrationRowValue;
  status: string;
  durationMs: number;
  errorMessage: string | null;
}): Promise<void> {
  const t = q(client.dialect, "migrate_logs");
  const setNow = nowExpr(client.dialect);
  await client.run(
    `UPDATE ${t} SET ${q(client.dialect, "status")} = ?, ${q(client.dialect, "finished_at")} = ${setNow}, ${q(client.dialect, "duration_ms")} = ?, ${q(client.dialect, "error_message")} = ?, ${q(client.dialect, "updated")} = ${setNow} WHERE ${q(client.dialect, "id")} = ?`,
    [status, durationMs, errorMessage, id],
  );
}

function nowExpr(dialect: string): string {
  switch (dialect) {
    case "sqlite":
      return "CURRENT_TIMESTAMP";
    case "postgres":
      return "NOW()";
    case "mysql":
      return "CURRENT_TIMESTAMP";
    case "sqlserver":
      return "SYSUTCDATETIME()";
    case "oracle":
      return "CURRENT_TIMESTAMP";
    default:
      throw new Error(`Unhandled dialect: ${dialect}`);
  }
}

function limitClause(dialect: string, n: number): string {
  switch (dialect) {
    case "sqlserver":
      return `OFFSET 0 ROWS FETCH NEXT ${n} ROWS ONLY`;
    case "oracle":
      return `FETCH FIRST ${n} ROWS ONLY`;
    default:
      return `LIMIT ${n}`;
  }
}

function requireDialect(dialect: string): SqlDialect {
  const key = normalizeDialect(dialect);
  if (!key) {
    throw new Error(
      `Unknown SQL dialect "${dialect}". Valid: sqlite, mysql, postgres, sqlserver, oracle.`,
    );
  }
  return key;
}
