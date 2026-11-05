import { join } from "node:path";
import type { CodegenLayout } from "../../codegen-layout.ts";
import {
  dbEnvContent,
  dbGitignoreContent,
} from "../../lib/migrate-scripts-plan.ts";
import { buildEntrypointMigrateBlock } from "./migrate-entrypoint.ts";
import { PATCH } from "./generate-result.ts";

interface PatchEntry {
  kind: string;
  filename: string;
  section: string;
  content: string;
}

/** DB config as shared-append PATCH entries shared by every language: a DB_ENV section into .env/.env.example and a DB_GITIGNORE section into .gitignore. The explicit `section` upserts alongside backend-app's ENV_/GITIGNORE_ sections and no-ops when the file is absent (migrate-only scaffold). Empty blocks are dropped — a dialect set with no sqlite gitignores nothing. */
export function dbFilePatches(dialects: string[]): PatchEntry[] {
  const env = dbEnvContent(dialects);
  const gitignore = dbGitignoreContent(dialects);
  return [
    { kind: PATCH, filename: ".env", section: "DB_ENV", content: env },
    { kind: PATCH, filename: ".env.example", section: "DB_ENV", content: env },
    {
      kind: PATCH,
      filename: ".gitignore",
      section: "DB_GITIGNORE",
      content: gitignore,
    },
  ].filter((e) => e.content.length > 0);
}

/** A marked-block PATCH entry naming the `section` it replaces — Cargo.toml MIGRATE_BIN/DEPS, an app *.csproj DIALECT_PACKAGES, etc. The patcher resolves the section's markers. */
export function markedEntry(
  filename: string,
  section: string,
  content: string,
): PatchEntry {
  return { kind: PATCH, filename, section, content };
}

/** A Dockerfile marked-block PATCH entry — APK_CLIENTS / MIGRATE_COPY / MIGRATE_RUNTIME_COPY. Naming a `section` marks it as a marked-block replacement to the Dockerfile writer. */
function dockerfileMarked(section: string, content: string): PatchEntry {
  return { kind: PATCH, filename: "Dockerfile", section, content };
}

/** The migrate builder (MIGRATE_COPY) + runtime (MIGRATE_RUNTIME_COPY) Dockerfile marked blocks, given each language's rendered COPY content. No-op when the Dockerfile is absent (standalone). */
export function dockerfileCopyPatches(
  builderBlock: string,
  runtimeBlock: string,
): PatchEntry[] {
  return [
    dockerfileMarked("MIGRATE_COPY", builderBlock),
    dockerfileMarked("MIGRATE_RUNTIME_COPY", runtimeBlock),
  ];
}

/** The MIGRATE_HOOK marked-block entry into scripts/entrypoint.sh (dialect-select + migrate run, per language). */
export function entrypointPatch(
  language: string,
  migrateDir: string,
  layout: CodegenLayout,
): PatchEntry {
  return {
    kind: PATCH,
    filename: join("scripts", "entrypoint.sh"),
    section: "MIGRATE_HOOK",
    content: buildEntrypointMigrateBlock(language, migrateDir, layout),
  };
}
