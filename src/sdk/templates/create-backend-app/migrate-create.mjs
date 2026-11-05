#!/usr/bin/env node
// Scaffolds a new <NNNN>_<name>_{up,down}.sql pair in the migrations directory. Numbering is max(1-4-digit prefix in dir)+1; legacy timestamp prefixes are ignored.

import {  mkdir, readdir, writeFile  } from "node:fs/promises";
import { normalizeDialect } from "@deterministic-code/deterministic/migrate";

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const SEQ_RE = /^(\d{1,4})_.*_up\.sql$/;

const HELP_TEXT = `Usage: migrate-create --provider <sqlite|postgres|mysql|sqlserver|oracle> --name <snake_case_slug> [--migrations-path <dir>]

Creates a new <NNNN>_<name>_up.sql + <NNNN>_<name>_down.sql pair scaffolded
with TODO placeholders. NNNN is one greater than the highest 1-4-digit
sequence prefix already present in the migrations directory (starts at 0001).
Legacy timestamp-prefixed filenames are ignored for numbering.

  --provider          Database dialect. Required.
  --name              snake_case slug for the new migration. Required. Must
                      match /^[a-z][a-z0-9_]*$/.
  --migrations-path   Migrations directory (default: ./sql/<dialect>/migrations).
                      Created with mkdir -p if it does not exist.

Examples:
  migrate-create --provider sqlite --name add_users
  migrate-create --provider postgres --name backfill_email_lower --migrations-path ./db/changes/postgres
`;

function parseArgs(argv) {
  const args = { provider: null, name: null, migrationsPath: null };
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
    else if ((v = take("--name")) !== undefined) args.name = v;
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

async function nextSequence(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return 1;
    throw err;
  }
  let max = 0;
  for (const name of entries) {
    const m = SEQ_RE.exec(name);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max + 1;
}

function pad4(n) {
  return String(n).padStart(4, "0");
}

function main() {
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
  if (!args.name) {
    process.stderr.write("missing --name\n");
    process.exit(2);
  }
  if (!NAME_RE.test(args.name)) {
    process.stderr.write(
      `--name must be snake_case: lowercase letter then [a-z0-9_] (got "${args.name}")\n`,
    );
    process.exit(2);
  }

  const migrationsPath = args.migrationsPath ?? `./sql/${dialect}/migrations`;
  await mkdir(migrationsPath, { recursive: true });

  const seq = pad4(await nextSequence(migrationsPath));
  const upName = `${seq}_${args.name}_up.sql`;
  const downName = `${seq}_${args.name}_down.sql`;
  await writeFile(
    `${migrationsPath}/${upName}`,
    `-- TODO: write the up migration for "${args.name}"\n`,
  );
  await writeFile(
    `${migrationsPath}/${downName}`,
    `-- TODO: write the down migration for "${args.name}"\n`,
  );
  process.stdout.write(`Created: ${upName}\n`);
  process.stdout.write(`Created: ${downName}\n`);
}

try {
  main();
} catch (e) {
  process.stderr.write(`${e?.stack ?? e?.message ?? String(e)}\n`);
  process.exit(1);
}
