import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLibraryReferenceMode } from "../../sdk/read-settings.ts";
import { replaceMarkedBlockText } from "@deterministic-code/patch-merger";
import { rewriteLibraryImports } from "./library-import.ts";
import { setupSql } from "../../sdk/lib/migrate-setup-sql.ts";
import { PACK_TEMPLATES_DIR } from "../../pack-root.ts";
import {
  apkClientsContent,
  dialectDriver,
} from "../../sdk/lib/migrate-scripts-plan.ts";
import {
  TEST_DB_RELATIVE_PATH,
  renderDbDriverShims,
  buildAppTsDbHookImportsBlock,
  buildAppTsBeforeHookBlock,
  buildAppTsAfterHookBlock,
  buildTestAppDbConnBlock,
  buildMigrateScripts,
  buildPretestScript,
} from "./generate-backend-app-typescript.ts";
import {
  dbFilePatches,
  entrypointPatch,
} from "../../sdk/codegen/lib/migrate-sibling-patches.ts";
import {
  CONTENT,
  PATCH,
} from "../../sdk/codegen/lib/generate-result.ts";
import {
  makeMigrateGenerate,
  MIGRATE_DIR_FLAG,
} from "../../sdk/codegen/lib/migrate-generate-helpers.ts";
import { COMBINED_FLAG } from "../../sdk/codegen/lib/backend-lane.ts";
import { layoutForSettings } from "../../sdk/codegen/lib/ts-codegen-naming.ts";
import type {
  ContentEntry,
  PatchEntry,
  MigrateEntry,
  MigrateLayout,
  MigrateRenderOptions,
} from "../../sdk/codegen/lib/migrate-scripts-generate-types.ts";

const currentDir = dirname(fileURLToPath(import.meta.url));
const templatesDir = PACK_TEMPLATES_DIR;
const runnerTemplate = (name: string): Promise<string> =>
  readFile(resolve(templatesDir, "create-backend-app", name), "utf8");
const RUNNER_SCRIPTS = [
  "migrate-up.mjs",
  "migrate-down.mjs",
  "migrate-create.mjs",
];

/** A runner `.mjs` with its `@deterministic-code/deterministic` imports resolved for the file's spot in the scaffold — a no-op in npm mode, the vendored relative path in bundled mode. */
async function runnerScript(
  name: string,
  migrateDir: string,
  libraryReferenceMode: string,
): Promise<string> {
  return rewriteLibraryImports(
    await runnerTemplate(name),
    libraryReferenceMode,
    `${migrateDir}/${name}`,
  );
}

const SETUP_DDL_START = "// === BEGIN SETUP_DDL ===";
const SETUP_DDL_END = "// === END SETUP_DDL ===";
const ALL_MIGRATE_DIALECTS = [
  "sqlite",
  "postgres",
  "mysql",
  "sqlserver",
  "oracle",
];

/** migrate-setup.mjs with its bookkeeping-table DDL inlined — the generated runner carries its own `SETUP_DDL_BY_DIALECT` map (derived here from the canonical `setupSql`) rather than importing it at runtime, mirroring the self-contained rust/csharp setup binaries. All dialects are baked so the runner accepts any `--provider`, matching the prior library-import behavior. */
async function migrateSetupScript(
  migrateDir: string,
  libraryReferenceMode: string,
): Promise<string> {
  const map = Object.fromEntries(
    ALL_MIGRATE_DIALECTS.map((d) => [d, setupSql(d)]),
  );
  const filled = replaceMarkedBlockText({
    original: await runnerTemplate("migrate-setup.mjs"),
    startMarker: SETUP_DDL_START,
    endMarker: SETUP_DDL_END,
    block: `const SETUP_DDL_BY_DIALECT = ${JSON.stringify(map, null, 2)};`,
  });
  return rewriteLibraryImports(
    filled,
    libraryReferenceMode,
    `${migrateDir}/migrate-setup.mjs`,
  );
}

const content = (filename: string, contents: string): ContentEntry => ({
  kind: CONTENT,
  filename,
  contents,
});
const patch = (
  filename: string,
  section: string,
  content: string,
): PatchEntry => ({
  kind: PATCH,
  filename,
  section,
  content,
});

/** DB-wiring marker-block PATCH entries into the sibling backend scaffold (app.ts / test-app / entrypoint). Empty blocks (already-empty template sections) are dropped — patch entries require non-empty content. */
function appWiringPatches(
  migrateDir: string,
  libraryReferenceMode: string,
  layout: MigrateLayout,
): PatchEntry[] {
  return [
    patch(
      "app.ts",
      "APP_DB_IMPORTS",
      buildAppTsDbHookImportsBlock(libraryReferenceMode),
    ),
    patch("app.ts", "APP_BEFORE_HOOK", buildAppTsBeforeHookBlock()),
    patch("app.ts", "APP_AFTER_HOOK", buildAppTsAfterHookBlock()),
    patch(
      join("__tests__", "test-app.ts"),
      "TESTAPP_DB_CONN",
      buildTestAppDbConnBlock(libraryReferenceMode),
    ),
    entrypointPatch("typescript", migrateDir, layout),
  ].filter((p) => p.content.length > 0);
}

/** The migrate runner scripts + driver shims as content entries. migrate-setup.mjs inlines its bookkeeping DDL per selected dialect (self-contained, no runtime `setupSql` import). Library imports (runner `.mjs`, the app.ts/test-app DB-hook blocks, the pretest build step) resolve against `libraryReferenceMode` so bundled scaffolds point at the vendored `_deterministic/` copy instead of an uninstalled npm package. */
async function tsEntries({
  migrateDir,
  dialects = [],
  settings,
  combined,
}: MigrateRenderOptions): Promise<MigrateEntry[]> {
  const libraryReferenceMode = resolveLibraryReferenceMode(
    settings?.languages,
    "typescript",
  );
  const layout = layoutForSettings(settings, "typescript");
  const entries: MigrateEntry[] = await Promise.all(
    RUNNER_SCRIPTS.map(async (name) =>
      content(
        join(migrateDir, name),
        await runnerScript(name, migrateDir, libraryReferenceMode),
      ),
    ),
  );
  entries.push(
    content(
      join(migrateDir, "migrate-setup.mjs"),
      await migrateSetupScript(migrateDir, libraryReferenceMode),
    ),
  );
  const shims = renderDbDriverShims(dialects);
  if (shims) {
    entries.push(
      content(join(layout.sharedDir(), "db-driver-shims.d.ts"), shims),
    );
  }
  entries.push(...appWiringPatches(migrateDir, libraryReferenceMode, layout));
  entries.push(
    packageJsonPatch(migrateDir, dialects, { libraryReferenceMode, layout }),
  );
  entries.push(...dbFilePatches(dialects));
  const { lane, shared } = layout.migrateDockerCopyPrefixes({ combined });
  entries.push(
    ...dockerfilePatches(migrateDir, dialects, {
      lanePrefix: lane,
      sharedPrefix: shared,
      containerSqlRoot: layout.containerSqlRoot(),
    }),
  );
  return entries;
}

/** DB image wiring as Dockerfile PATCH entries: COPY the sql + migrate dirs into the image and the APK client packages (marked block). `lanePrefix` (e.g. `typescript/` or `backend/typescript/`) points the migrate-dir COPY at the lane subtree for a multi-language build whose context is the project root; `sharedPrefix` (e.g. `backend/`) points the sql COPY at the backend-shared tree, which carries no `<lang>/` segment. No-op when the Dockerfile is absent (migrate-only scaffold). */
export function dockerfilePatches(
  migrateDir: string,
  dialects: string[],
  {
    lanePrefix = "",
    sharedPrefix = "",
    containerSqlRoot,
  }: {
    lanePrefix?: string;
    sharedPrefix?: string;
    containerSqlRoot?: string;
  } = {},
): PatchEntry[] {
  if (!containerSqlRoot) {
    throw new Error(
      "dockerfilePatches: containerSqlRoot is required (layout.containerSqlRoot())",
    );
  }
  const copies = [
    { src: `${sharedPrefix}sql`, dest: containerSqlRoot },
    { src: `${lanePrefix}${migrateDir}`, dest: `./${migrateDir}` },
  ];
  return [
    {
      kind: PATCH,
      filename: "Dockerfile",
      content: JSON.stringify({ anchorSection: "MIGRATE_COPY", copies }),
    },
    {
      kind: PATCH,
      filename: "Dockerfile",
      section: "APK_CLIENTS",
      content: apkClientsContent(dialects),
    },
  ].filter((e) => e.content.length > 0);
}

/** The migrate additions to package.json as a deep-merge PATCH entry: migrate:* scripts + pretest, the test_db config, driver deps, and (when a driver runs install scripts) its allowScripts flag. Sections deep-merge into the scaffold's package.json via packageJsonMergeWriter. */
function packageJsonPatch(
  migrateDir: string,
  dialects: string[],
  {
    libraryReferenceMode,
    layout,
  }: { libraryReferenceMode: string; layout: MigrateLayout },
): PatchEntry {
  const scripts = {
    ...buildMigrateScripts(migrateDir, dialects, layout),
    pretest: buildPretestScript(migrateDir, libraryReferenceMode, layout),
  };
  const dependencies: Record<string, string> = {};
  const allowScripts: Record<string, boolean> = {};
  for (const dialect of dialects) {
    const driver = dialectDriver(dialect);
    if (!driver) continue;
    dependencies[driver.name] = driver.version;
    if (driver.installScripts) allowScripts[driver.name] = true;
  }
  const merge: Record<string, unknown> = {
    scripts,
    config: { test_db: TEST_DB_RELATIVE_PATH },
    dependencies,
  };
  if (Object.keys(allowScripts).length > 0) merge.allowScripts = allowScripts;
  return {
    kind: PATCH,
    filename: "package.json",
    content: JSON.stringify(merge),
  };
}

/** Every migrate target (runner files + app.ts/test-app/entrypoint/package.json/.env/.gitignore/Dockerfile) is generated by tsEntries as a CONTENT or PATCH entry — no sibling-patching `patch()` remains. */
export const migrateTypescript = {
  language: "typescript",
  generate: tsEntries,
};

export const generate = makeMigrateGenerate(tsEntries);
export const flags = [MIGRATE_DIR_FLAG, COMBINED_FLAG];
export const entriesNative = true;
export const pinProjectRoot = true;
