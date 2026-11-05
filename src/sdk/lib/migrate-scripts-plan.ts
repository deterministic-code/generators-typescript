import { CONTAINER_SQL_ROOT } from "../codegen-layout.ts";
import { DIALECT_DRIVER_PACKAGES, type SqlDialect } from "./generate-sql.ts";

interface PatchSection {
  id: string;
}

interface PatchPlanEntry {
  path: string;
  kind: string;
  sections?: PatchSection[];
  ownedKeys?: string[];
}

interface DialectDriver {
  name: string;
  version: string;
  installScripts: boolean;
}

/** apk packages that need to land in the runtime image so the per-dialect client binary is available; oracle/sqlserver bundle their driver into node_modules. */
export const DIALECT_APK_CLIENTS: Record<string, string> = {
  sqlite: "sqlite",
  postgres: "postgresql-client",
  mysql: "mysql-client",
};

export function dialectDriver(dialect: string): DialectDriver | null {
  const entry = DIALECT_DRIVER_PACKAGES[dialect as SqlDialect];
  if (!entry) return null;
  return {
    name: entry.name,
    version: entry.version,
    installScripts: entry.installScripts === true,
  };
}

function pickDefaultDialect(dialects: string[]): string {
  return dialects.includes("sqlite") ? "sqlite" : dialects[0];
}

export function dbEnvContent(dialects: string[]): string {
  const list = dialects.length > 0 ? dialects : ["sqlite"];
  const def = pickDefaultDialect(list);
  const lines = [`DATABASE_BACKEND=${def}`];
  if (def === "sqlite") {
    lines.push("DB_PATH=./dev.sqlite");
  } else {
    lines.push("DATABASE_URL=");
  }
  return lines.join("\n") + "\n";
}

export function dbGitignoreContent(dialects: string[]): string {
  if (!dialects.includes("sqlite")) return "";
  return [
    "*.sqlite",
    "*.sqlite3",
    "*.db",
    "*.db-journal",
    "*.db-wal",
    "*.db-shm",
    ".test/",
    "",
  ].join("\n");
}

export function apkClientsContent(dialects: string[]): string {
  const seen = new Set<string>();
  const pkgs: string[] = [];
  for (const d of dialects) {
    const p = DIALECT_APK_CLIENTS[d];
    if (!p || seen.has(p)) continue;
    seen.add(p);
    pkgs.push(p);
  }
  const tail = pkgs.length > 0 ? ` ${pkgs.join(" ")}` : "";
  return `RUN apk add --no-cache git${tail}\n`;
}

export function migrateCopyContent(migrateDir: string): string {
  const lines = [
    `COPY sql ${CONTAINER_SQL_ROOT}`,
    `COPY ${migrateDir} ./${migrateDir}`,
  ];
  return lines.join("\n") + "\n";
}

/** The migrate runner dir sits beside src/ (migrate/, matching the typescript layout), so the builder stage must copy it explicitly — it no longer rides `COPY src ./src`. `lanePrefix` (e.g. `rust/`) points the migrate-dir COPY at the lane subtree for a multi-language build whose context is the project root; `sharedPrefix` (e.g. `backend/` or `` for non-combined) points the sql COPY at the backend-shared tree, which carries no `<lang>/` segment. */
export function rustMigrateCopyContent(
  migrateDir: string,
  lanePrefix = "",
  sharedPrefix = "",
): string {
  return `COPY ${sharedPrefix}sql ./sql\nCOPY ${lanePrefix}${migrateDir} ./${migrateDir}\n`;
}

const RUST_SQLX_FEATURE_BY_DIALECT: Record<string, string> = {
  sqlite: "sqlite",
  postgres: "postgres",
  mysql: "mysql",
};

export function rustSqlxDepLine(dialects: string[] = []): string {
  const features = ["runtime-tokio"];
  for (const d of dialects) {
    const f = RUST_SQLX_FEATURE_BY_DIALECT[d];
    if (f && !features.includes(f)) features.push(f);
  }
  return `sqlx = { version = "0.8", default-features = false, features = [${features.map((f) => `"${f}"`).join(", ")}] }`;
}

export function rustMigrateBinBlock(migrateDir: string): string {
  const prefix = migrateDir && migrateDir !== "." ? `${migrateDir}/` : "";
  return ["setup", "up", "down", "create"]
    .map(
      (name) =>
        `[[bin]]\nname = "migrate-${name}"\npath = "${prefix}migrate_${name}.rs"`,
    )
    .join("\n\n");
}

export function rustMigrateRuntimeCopyContent(sharedPrefix = ""): string {
  return `COPY --from=builder /app/target/release/migrate-setup /app/target/release/migrate-setup
COPY --from=builder /app/target/release/migrate-up /app/target/release/migrate-up
COPY --from=builder /app/target/release/migrate-down /app/target/release/migrate-down
COPY --from=builder /app/target/release/migrate-create /app/target/release/migrate-create
COPY ${sharedPrefix}sql ${CONTAINER_SQL_ROOT}
`;
}

export function csharpMigrateCopyContent(
  migrateDir: string,
  lanePrefix = "",
  sharedPrefix = "",
): string {
  return `COPY ${sharedPrefix}sql ./sql
COPY ${lanePrefix}${migrateDir} ./${migrateDir}
RUN dotnet publish ${migrateDir}/MigrateRunner.csproj -c Release -o /app/migrate-publish
`;
}

export function csharpMigrateRuntimeCopyContent(
  migrateDir: string,
  _lanePrefix = "",
  sharedPrefix = "",
): string {
  return `COPY --from=build /app/migrate-publish ./${migrateDir}
COPY ${sharedPrefix}sql ${CONTAINER_SQL_ROOT}
`;
}

/** The migrate entrypoint hook + DB config files (.env/.env.example/.gitignore) — every language's plan shares these verbatim, so they live here and spread into each. */
const SHARED_MIGRATE_ENTRIES: PatchPlanEntry[] = [
  {
    path: "scripts/entrypoint.sh",
    kind: "marked",
    sections: [{ id: "MIGRATE_HOOK" }],
  },
  { path: ".env", kind: "shared", sections: [{ id: "DB_ENV" }] },
  { path: ".env.example", kind: "shared", sections: [{ id: "DB_ENV" }] },
  { path: ".gitignore", kind: "shared", sections: [{ id: "DB_GITIGNORE" }] },
];

/** Per-file declaration of every section the patch contract owns. A `marked` entry's `sections[].id` keys into SECTION_MARKERS (the region is bounded by BEGIN/END markers in the generated file); a `shared` entry (.env/.env.example/.gitignore) contributes a marker-free section that the shared-append merger composes at EOF. package.json sits outside both — it's owned by JSON-merge. */
export const PATCH_PLAN_TYPESCRIPT: PatchPlanEntry[] = [
  {
    path: "app.ts",
    kind: "marked",
    sections: [
      { id: "APP_DB_IMPORTS" },
      { id: "APP_BEFORE_HOOK" },
      { id: "APP_AFTER_HOOK" },
    ],
  },
  {
    path: "__tests__/test-app.ts",
    kind: "marked",
    sections: [{ id: "TESTAPP_DB_CONN" }],
  },
  {
    path: "Dockerfile",
    kind: "marked",
    sections: [{ id: "APK_CLIENTS" }, { id: "MIGRATE_COPY" }],
  },
  ...SHARED_MIGRATE_ENTRIES,
  {
    path: "package.json",
    kind: "ownedKeys",
    ownedKeys: [
      "scripts.migrate:setup",
      "scripts.migrate",
      "scripts.migrate:down",
      "scripts.pretest",
      "config.test_db",
      "dependencies.<dialect-driver>",
      "allowScripts.<dialect-driver>",
    ],
  },
];

/** Rust parity of PATCH_PLAN_TYPESCRIPT. `src/main.rs` is the app entrypoint; Cargo.toml's MIGRATE_BIN/MIGRATE_DEPS markers get the migrate bins plus an sqlx dep narrowed to the selected dialects. The migrate/ subdir is wholly owned by this step — every file declared so the contract is self-describing (unlike TS where the migrate runner scripts sit outside the plan). */
export const PATCH_PLAN_RUST: PatchPlanEntry[] = [
  {
    path: "Dockerfile",
    kind: "marked",
    sections: [{ id: "MIGRATE_COPY" }, { id: "MIGRATE_RUNTIME_COPY" }],
  },
  ...SHARED_MIGRATE_ENTRIES,
  { path: "Cargo.toml", kind: "ownedFile" },
  { path: "migrate/migrate_setup.rs", kind: "ownedFile" },
  { path: "migrate/migrate_up.rs", kind: "ownedFile" },
  { path: "migrate/migrate_down.rs", kind: "ownedFile" },
  { path: "migrate/migrate_create.rs", kind: "ownedFile" },
];

/** C# parity of PATCH_PLAN_TYPESCRIPT. Program.cs is the app entrypoint; the .csproj has a DIALECT_PACKAGES marker (XML-comment style) that migrate-scripts patches with per-dialect ADO.NET driver PackageReferences (Microsoft.Data.Sqlite, Npgsql, MySqlConnector). The migrate/ subdir mirrors Rust — every generated file listed as ownedFile so the contract is self-describing. */
export const PATCH_PLAN_CSHARP: PatchPlanEntry[] = [
  {
    path: "Program.cs",
    kind: "marked",
    sections: [
      { id: "APP_DB_IMPORTS" },
      { id: "APP_BEFORE_HOOK" },
      { id: "APP_AFTER_HOOK" },
    ],
  },
  {
    path: "Dockerfile",
    kind: "marked",
    sections: [{ id: "MIGRATE_COPY" }, { id: "MIGRATE_RUNTIME_COPY" }],
  },
  ...SHARED_MIGRATE_ENTRIES,
  {
    path: "*.csproj",
    kind: "marked",
    sections: [{ id: "DIALECT_PACKAGES" }],
  },
  {
    path: "migrate/MigrateRunner.csproj",
    kind: "marked",
    sections: [{ id: "DIALECT_PACKAGES" }],
  },
  { path: "migrate/Program.cs", kind: "ownedFile" },
  {
    path: "migrate/MigrateSetup.cs",
    kind: "marked",
    sections: [
      { id: "DIALECT_USINGS" },
      { id: "DIALECT_DDL_CONSTS" },
      { id: "DIALECT_SWITCH_ARMS" },
    ],
  },
  {
    path: "migrate/MigrateUp.cs",
    kind: "marked",
    sections: [
      { id: "DIALECT_USINGS" },
      { id: "DIALECT_SQLITE_PRECHECK" },
      { id: "DIALECT_DISPATCH_ARMS" },
      { id: "DIALECT_RUNNER_METHODS" },
    ],
  },
  {
    path: "migrate/MigrateDown.cs",
    kind: "marked",
    sections: [
      { id: "DIALECT_USINGS" },
      { id: "DIALECT_SQLITE_PRECHECK" },
      { id: "DIALECT_DISPATCH_ARMS" },
      { id: "DIALECT_ROLLBACK_METHODS" },
    ],
  },
  { path: "migrate/MigrateCreate.cs", kind: "ownedFile" },
  {
    path: "migrate/ProviderConnectionString.cs",
    kind: "marked",
    sections: [{ id: "DIALECT_USINGS" }, { id: "DIALECT_METHODS" }],
  },
];

export const PATCH_PLAN = PATCH_PLAN_TYPESCRIPT;

export function getPatchPlan(language: string): PatchPlanEntry[] {
  if (language === "typescript") return PATCH_PLAN_TYPESCRIPT;
  if (language === "rust") return PATCH_PLAN_RUST;
  if (language === "csharp") return PATCH_PLAN_CSHARP;
  throw new Error(
    `getPatchPlan: no PATCH_PLAN defined for language "${language}"`,
  );
}
