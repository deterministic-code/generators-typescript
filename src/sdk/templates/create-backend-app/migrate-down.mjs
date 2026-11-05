#!/usr/bin/env node
// Rolls back the most recently applied migration (one step). DESTRUCTIVE: prints a random 4-letter uppercase confirmation token and refuses to proceed unless the user types it back on stdin. Pass --confirm <TOKEN> matching the printed token to bypass the interactive prompt (CI / scripted use).

import { pathExists } from "@deterministic-code/deterministic";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createClient,
  discoverMigrations,
  normalizeDialect,
  runDown,
} from "@deterministic-code/deterministic/migrate";

const ENV_VARS_BY_DIALECT = {
  sqlite: ["SQLITE_PATH", "DB_PATH"],
  postgres: ["PG_CONNECTION_STRING", "DATABASE_URL"],
  mysql: ["MYSQL_URL", "DATABASE_URL"],
  sqlserver: ["MSSQL_URL", "DATABASE_URL"],
  oracle: ["ORACLE_CONNECT_STRING", "DATABASE_URL"],
};

const HELP_TEXT = `Usage: migrate-down --provider <sqlite|postgres|mysql|sqlserver|oracle> --connection <url> [--migrations-path <dir>] [--migrations-root <dir>] [--confirm <TOKEN>]

Rolls back the MOST RECENTLY applied migration (one step). DESTRUCTIVE: prints a
random 4-letter uppercase token on stderr and refuses to proceed unless the
operator types it back on stdin (or passes --confirm <TOKEN> matching it).

  --provider          Database dialect. Required.
  --connection        Connection string. Required (or set the per-dialect env var below).
  --migrations-path   Full path to the migrations directory.
  --migrations-root   Root prefix; the script then looks at <migrations-root>/<dialect>/migrations.
                      Defaults to 'sql'. Ignored when --migrations-path is also set.
  --confirm           Skip the interactive prompt. The TOKEN must match the value
                      printed on stderr at runtime — there is no fixed bypass value.

Examples:
  # sqlite — bare path or sqlite:// URL.
  migrate-down --provider sqlite --connection ./app.sqlite
  migrate-down --provider sqlite --connection sqlite:///absolute/path/app.sqlite

  # postgres — URL or libpq keyword form.
  migrate-down --provider postgres --connection postgresql://user:pass@host:5432/dbname

  # mysql — URL form.
  migrate-down --provider mysql --connection mysql://user:pass@host:3306/dbname

  # sqlserver / oracle — pass a driver-native connection string.
  migrate-down --provider sqlserver --connection "Server=host;Database=dbname;User Id=user;Password=pass;"
  migrate-down --provider oracle   --connection "user/pass@host:1521/service"

  # env-var fallback (typescript only; rust + csharp require --connection):
  SQLITE_PATH=./app.sqlite       migrate-down --provider sqlite
  DATABASE_URL=postgresql://...  migrate-down --provider postgres

  # custom migrations layout (default looks under sql/<dialect>/migrations):
  migrate-down --provider sqlite --connection ./app.sqlite --migrations-path ./db/changes/sqlite

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
    confirm: null,
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
    else if ((v = take("--confirm")) !== undefined) args.confirm = v;
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

function randomToken() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // omit I, O — visually ambiguous
  const buf = new Uint8Array(4);
  globalThis.crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < 4; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

async function promptConfirmation(token) {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      `migrate-down requires interactive confirmation when stdin is not a TTY — pass --confirm ${token} (this exact token, printed above) to proceed.\n`,
    );
    process.exit(2);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`Type ${token} to confirm rollback: `);
    return answer.trim() === token;
  } finally {
    rl.close();
  }
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

  const token = randomToken();
  process.stderr.write(
    `\n⚠ DESTRUCTIVE: this rolls back the most recently applied migration on ${dialect}.\n` +
      `  Confirmation token: ${token}\n\n`,
  );

  if (args.confirm !== null) {
    if (args.confirm !== token) {
      process.stderr.write(
        `--confirm value (${args.confirm}) does not match the token printed above (${token}). Aborting.\n`,
      );
      process.exit(2);
    }
  } else {
    const ok = await promptConfirmation(token);
    if (!ok) {
      process.stderr.write("Confirmation token did not match — aborting.\n");
      process.exit(2);
    }
  }

  const migratePath = resolve(resolveMigratePath(args, dialect));
  const client = await createClient({ provider: dialect, connection });
  try {
    const migrations = await discoverMigrations({ migratePath, dialect });
    const r = await runDown({ client, migrations });
    if (!r.rolledBack)
      process.stdout.write("No applied migrations to roll back.\n");
    else process.stdout.write(`Rolled back: ${r.name}\n`);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e?.message ?? String(e)}\n`);
  process.exit(1);
});
