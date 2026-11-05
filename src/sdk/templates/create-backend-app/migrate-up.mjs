#!/usr/bin/env node
// Default: applies ALL pending migrations in sequence, each in its own transaction. Pass --one to apply only the next pending migration (legacy one-shot behavior; useful when wrapping in an external loop or when you want to inspect state between steps).

import { pathExists } from "@deterministic-code/deterministic";
import { resolve } from "node:path";
import {
  createClient,
  discoverMigrations,
  normalizeDialect,
  runUp,
} from "@deterministic-code/deterministic/migrate";

const ENV_VARS_BY_DIALECT = {
  sqlite: ["SQLITE_PATH", "DB_PATH"],
  postgres: ["PG_CONNECTION_STRING", "DATABASE_URL"],
  mysql: ["MYSQL_URL", "DATABASE_URL"],
  sqlserver: ["MSSQL_URL", "DATABASE_URL"],
  oracle: ["ORACLE_CONNECT_STRING", "DATABASE_URL"],
};

const HELP_TEXT = `Usage: migrate-up --provider <sqlite|postgres|mysql|sqlserver|oracle> --connection <url> [--migrations-path <dir>] [--migrations-root <dir>] [--one]

Applies ALL pending migrations in sequence, each in its own transaction.

  --provider          Database dialect. Required.
  --connection        Connection string. Required (or set the per-dialect env var below).
  --migrations-path   Full path to the migrations directory (e.g. sql/sqlite/migrations).
  --migrations-root   Root prefix; the script then looks at <migrations-root>/<dialect>/migrations.
                      Defaults to 'sql'. Ignored when --migrations-path is also set.
  --one               Apply only the next pending migration, then exit. Default is to apply all pending migrations.

Examples:
  # sqlite — bare path or sqlite:// URL; both create a file on disk.
  migrate-up --provider sqlite --connection ./app.sqlite
  migrate-up --provider sqlite --connection sqlite:///absolute/path/app.sqlite

  # postgres — URL or libpq keyword form.
  migrate-up --provider postgres --connection postgresql://user:pass@host:5432/dbname

  # mysql — URL form.
  migrate-up --provider mysql --connection mysql://user:pass@host:3306/dbname

  # sqlserver / oracle — pass a driver-native connection string.
  migrate-up --provider sqlserver --connection "Server=host;Database=dbname;User Id=user;Password=pass;"
  migrate-up --provider oracle   --connection "user/pass@host:1521/service"

  # env-var fallback (typescript only; rust + csharp require --connection):
  SQLITE_PATH=./app.sqlite       migrate-up --provider sqlite
  DATABASE_URL=postgresql://...  migrate-up --provider postgres

  # custom migrations layout (default looks under sql/<dialect>/migrations):
  migrate-up --provider sqlite --connection ./app.sqlite --migrations-path ./db/changes/sqlite
  migrate-up --provider sqlite --connection ./app.sqlite --migrations-root ./db/changes

  # one-shot: apply the next pending migration only, then exit.
  migrate-up --provider sqlite --connection ./app.sqlite --one

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
    migratePath: null,
    migrateRoot: null,
    connection: null,
    one: false,
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
    if (a === "--one") {
      args.one = true;
      continue;
    }
    let v;
    if ((v = take("--provider")) !== undefined) args.provider = v;
    // --migrate-path / --migrate-root are silent aliases retained for backward compat.
    else if ((v = take("--migrations-path")) !== undefined)
      args.migratePath = v;
    else if ((v = take("--migrate-path")) !== undefined) args.migratePath = v;
    else if ((v = take("--migrations-root")) !== undefined)
      args.migrateRoot = v;
    else if ((v = take("--migrate-root")) !== undefined) args.migrateRoot = v;
    else if ((v = take("--connection")) !== undefined) args.connection = v;
    else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

function resolveMigratePath(args, dialect) {
  if (args.migratePath) return args.migratePath;
  const root = args.migrateRoot ?? "sql";
  return `${root}/${dialect}/migrations`;
}

function resolveConn(dialect, fromFlag) {
  if (fromFlag) return fromFlag;
  for (const name of ENV_VARS_BY_DIALECT[dialect] ?? []) {
    if (process.env[name]) return process.env[name];
  }
  return null;
}

// Returns the filesystem path for a sqlite connection string, or null for :memory: (which is always ephemeral and should skip the existence check).
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

  if (dialect === "sqlite") {
    const path = sqliteFilesystemPath(connection);
    if (path !== null && !(await pathExists(path))) {
      process.stderr.write(
        `sqlite file: ${path} does not exist — run 'migrate-setup --provider sqlite --connection ${path}' to create it\n`,
      );
      process.exit(2);
    }
  }

  const migratePath = resolve(resolveMigratePath(args, dialect));
  const client = await createClient({ provider: dialect, connection });
  try {
    const migrations = await discoverMigrations({ migratePath, dialect });
    let appliedCount = 0;
    for (;;) {
      const r = await runUp({ client, migrations });
      if (!r.applied) {
        if (appliedCount === 0)
          process.stdout.write("No pending migrations.\n");
        else process.stdout.write(`No more pending migrations.\n`);
        break;
      }
      process.stdout.write(`Applied: ${r.name}\n`);
      appliedCount++;
      if (args.one) break;
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e?.message ?? String(e)}\n`);
  process.exit(1);
});
