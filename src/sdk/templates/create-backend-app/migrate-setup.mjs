#!/usr/bin/env node
// Idempotent migrate-setup for the consumer's container — creates the migrates + migrate_logs tracking tables per dialect. The per-dialect bookkeeping DDL is inlined below (SETUP_DDL_BY_DIALECT) so this runner is self-contained, matching the rust/csharp setup binaries; the codegen generator fills it from the canonical datasource-migrate DDL source.

import { mkdir } from "node:fs/promises";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createClient,
  normalizeDialect,
} from "@deterministic-code/deterministic/migrate";

// === BEGIN SETUP_DDL ===
const SETUP_DDL_BY_DIALECT = {};
// === END SETUP_DDL ===

function setupSql(dialect) {
  return SETUP_DDL_BY_DIALECT[dialect];
}

const ENV_VARS_BY_DIALECT = {
  sqlite: ["SQLITE_PATH", "DB_PATH"],
  postgres: ["PG_CONNECTION_STRING", "DATABASE_URL"],
  mysql: ["MYSQL_URL", "DATABASE_URL"],
  sqlserver: ["MSSQL_URL", "DATABASE_URL"],
  oracle: ["ORACLE_CONNECT_STRING", "DATABASE_URL"],
};

const HELP_TEXT = `Usage: migrate-setup --provider <sqlite|postgres|mysql|sqlserver|oracle> --connection <url> [--migrations-path <dir>] [--and-up]

Creates the bookkeeping tables (migrates, migrate_logs) for the chosen dialect
and the migrations directory (mkdir -p). Idempotent — re-running against an
already-setup database is a no-op. For sqlite, also mkdir -p of the parent
directory of --connection so a fresh-tree path like ./.test/foo.sqlite works.

  --provider          Database dialect. Required.
  --connection        Connection string. Required (or set the per-dialect env var below).
  --migrations-path   Migrations directory (default: ./sql/<dialect>/migrations).
  --and-up            After setup, immediately invoke migrate-up so the chain is applied in one step.

Examples:
  # sqlite — bare path or sqlite:// URL; both create a file on disk.
  migrate-setup --provider sqlite --connection ./app.sqlite
  migrate-setup --provider sqlite --connection sqlite:///absolute/path/app.sqlite

  # postgres — URL or libpq keyword form.
  migrate-setup --provider postgres --connection postgresql://user:pass@host:5432/dbname

  # mysql — URL form.
  migrate-setup --provider mysql --connection mysql://user:pass@host:3306/dbname

  # sqlserver / oracle — pass a driver-native connection string.
  migrate-setup --provider sqlserver --connection "Server=host;Database=dbname;User Id=user;Password=pass;"
  migrate-setup --provider oracle   --connection "user/pass@host:1521/service"

  # env-var fallback (typescript only; rust + csharp require --connection):
  SQLITE_PATH=./app.sqlite       migrate-setup --provider sqlite
  DATABASE_URL=postgresql://...  migrate-setup --provider postgres
  DATABASE_URL=mysql://...       migrate-setup --provider mysql

Per-dialect env vars consulted when --connection is omitted:
  sqlite     SQLITE_PATH, DB_PATH
  postgres   PG_CONNECTION_STRING, DATABASE_URL
  mysql      MYSQL_URL, DATABASE_URL
  sqlserver  MSSQL_URL, DATABASE_URL
  oracle     ORACLE_CONNECT_STRING, DATABASE_URL
`;

function parseArgs(argv) {
  const args = {
    provider: null,
    connection: null,
    migrationsPath: null,
    andUp: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const take = (flag) => {
      const eq = `${flag}=`;
      if (a === flag) return rest[++i];
      if (a.startsWith(eq)) return a.slice(eq.length);
      return undefined;
    };
    if (a === "-h" || a === "--help") {
      process.stderr.write(HELP_TEXT);
      process.exit(0);
    }
    if (a === "--and-up") {
      args.andUp = true;
      continue;
    }
    let v;
    if ((v = take("--provider")) !== undefined) args.provider = v;
    else if ((v = take("--connection")) !== undefined) args.connection = v;
    // --migrate-path is a silent alias retained for backward compat with pre-rename callers.
    else if ((v = take("--migrations-path")) !== undefined)
      args.migrationsPath = v;
    else if ((v = take("--migrate-path")) !== undefined)
      args.migrationsPath = v;
    else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

function sqliteFilesystemPath(connection) {
  let s = connection.trim();
  const eq = s.indexOf("=");
  if (eq >= 0 && /data\s*source/i.test(s.slice(0, eq))) {
    s = s.slice(eq + 1).trim();
  } else if (/^sqlite:\/\//i.test(s)) {
    s = s.slice("sqlite://".length);
  } else if (/^sqlite:/i.test(s)) {
    s = s.slice("sqlite:".length);
  } else if (/^file:/i.test(s)) {
    s = s.slice("file:".length);
  }
  if (s === ":memory:" || s === "") return null;
  return s;
}

function resolveConn(dialect, fromFlag) {
  if (fromFlag) return fromFlag;
  for (const name of ENV_VARS_BY_DIALECT[dialect] ?? []) {
    if (process.env[name]) return process.env[name];
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.provider) {
    process.stderr.write("missing --provider\n");
    process.exit(2);
  }
  const dialect = normalizeDialect(args.provider);
  if (!dialect) {
    process.stderr.write(`unknown provider: ${args.provider}\n`);
    process.exit(2);
  }
  const connection = resolveConn(dialect, args.connection);
  if (!connection) {
    process.stderr.write(
      `missing --connection — pass --connection <url> (e.g. ./app.sqlite for sqlite) or set ${(ENV_VARS_BY_DIALECT[dialect] ?? []).join(" / ")}. Run with --help for examples.\n`,
    );
    process.exit(2);
  }

  const migrationsPath = args.migrationsPath ?? `./sql/${dialect}/migrations`;

  if (dialect === "sqlite") {
    const filePath = sqliteFilesystemPath(connection);
    if (filePath !== null) {
      await mkdir(dirname(filePath), { recursive: true });
    }
  }

  const client = await createClient({ provider: dialect, connection });
  try {
    for (const stmt of setupSql(dialect)) {
      await client.exec(stmt);
    }
    await mkdir(migrationsPath, { recursive: true });
    process.stdout.write(
      `Setup complete: migrates and migrate_logs ready (${dialect}).\n` +
        `Migrations directory: ${migrationsPath}\n`,
    );
    if (!args.andUp) {
      process.stdout.write(
        `\n` +
          `Next steps:\n` +
          `  # create a new migration\n` +
          `  node migrate-create.mjs --provider ${dialect} --name add_users\n` +
          `\n` +
          `  # apply pending migrations\n` +
          `  node migrate-up.mjs --provider ${dialect} --connection ${connection}\n`,
      );
    }
  } finally {
    await client.close();
  }

  if (args.andUp) {
    const upScript = pathResolve(
      dirname(fileURLToPath(import.meta.url)),
      "migrate-up.mjs",
    );
    const childArgs = [
      upScript,
      "--provider",
      dialect,
      "--connection",
      connection,
    ];
    if (args.migrationsPath) {
      childArgs.push("--migrations-path", args.migrationsPath);
    }
    const child = spawn(process.execPath, childArgs, { stdio: "inherit" });
    const [code] = await once(child, "exit");
    if (code !== 0) process.exit(code);
  }
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e?.message ?? String(e)}\n`);
  process.exit(1);
});
