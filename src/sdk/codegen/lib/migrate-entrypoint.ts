import type { CodegenLayout } from "../../codegen-layout.ts";
import { loadChunk, applyTokens } from "./chunk-loader.ts";

const ENTRYPOINT_MIGRATE_CHUNK = await loadChunk(
  "typescript",
  "entrypoint_migrate.sh",
);

interface CommandSet {
  setupCmd: string;
  upCmd: string;
  dialectCases: string;
}

/** The entrypoint migrates the on-disk sqlite CONN, then `exec`s the server — but the docker CMD is a bare `node dist/server.js` (no `--env-file`), so the generated `.env` DB_PATH never reaches it. Each lane's server reads the sqlite connection from a different env var, so the entrypoint must export that var here or the server boots on an empty in-memory DB while migrate populated the file (`no such table` on every query). `sqliteServerEnv` is that per-language export (ts/c# read DB_PATH, rust reads DATABASE_URL). URL dialects need no bridge — DATABASE_URL already IS the server's env. */
function entrypointDialectCases(
  urlDialects: string,
  sqliteServerEnv: string,
): string {
  const bridge = sqliteServerEnv ? `; export ${sqliteServerEnv}` : "";
  return `  sqlite) CONN="\${DB_PATH:-\${SQLITE_PATH:-./dev.sqlite}}"${bridge} ;;
  ${urlDialects})
    : "\${DATABASE_URL:?entrypoint: DATABASE_URL required for $DIALECT}"
    CONN="$DATABASE_URL" ;;`;
}

const ENTRYPOINT_MIGRATE_COMMANDS: Record<
  string,
  (migrateDir: string) => CommandSet
> = {
  typescript: (migrateDir) => ({
    setupCmd: `node ${migrateDir}/migrate-setup.mjs --provider "$DIALECT" --connection "$CONN"`,
    upCmd: `node ${migrateDir}/migrate-up.mjs --provider "$DIALECT" --migrate-path "$MIGRATIONS_DIR" --connection "$CONN"`,
    dialectCases: entrypointDialectCases(
      "postgres|mysql|sqlserver|oracle",
      'DB_PATH="$CONN"',
    ),
  }),
  rust: () => ({
    setupCmd: `./target/release/migrate-setup --provider "$DIALECT" --connection "$CONN"`,
    upCmd: `./target/release/migrate-up --provider "$DIALECT" --migrate-path "$MIGRATIONS_DIR" --connection "$CONN"`,
    dialectCases: entrypointDialectCases(
      "postgres|mysql",
      'DATABASE_URL="sqlite://$CONN"',
    ),
  }),
  csharp: (migrateDir) => ({
    setupCmd: `dotnet ${migrateDir}/MigrateRunner.dll setup --provider "$DIALECT" --connection "$CONN"`,
    upCmd: `dotnet ${migrateDir}/MigrateRunner.dll up --provider "$DIALECT" --migrate-path "$MIGRATIONS_DIR" --connection "$CONN"`,
    dialectCases: entrypointDialectCases("postgres|mysql", 'DB_PATH="$CONN"'),
  }),
};

/** Only the TS lane's `npm test` has a `pretest` that migrates the sqlite test DB; exporting the container migrations dir here (before entrypoint.sh's `exec "$@"`) lets that pretest resolve the absolute container path instead of the host-relative `../sql` it bakes for local dev. rust/csharp `cargo test`/`dotnet test` have no such hook, so the export is TS-only. */
function testMigrationsExportLine(
  language: string,
  layout: CodegenLayout,
): string {
  if (language !== "typescript") return "";
  return `export TEST_MIGRATIONS_DIR="${layout.containerMigrationsDir("sqlite")}"\n`;
}

export function buildEntrypointMigrateBlock(
  language: string,
  migrateDir: string,
  layout: CodegenLayout,
): string {
  const commandsFor = ENTRYPOINT_MIGRATE_COMMANDS[language];
  if (!commandsFor) {
    throw new Error(
      `buildEntrypointMigrateBlock: unsupported language "${language}"`,
    );
  }
  return (
    applyTokens(ENTRYPOINT_MIGRATE_CHUNK, {
      ...commandsFor(migrateDir),
      containerSqlRoot: layout.containerSqlRoot(),
      testMigrationsExport: testMigrationsExportLine(language, layout),
    }) + "\n"
  );
}
