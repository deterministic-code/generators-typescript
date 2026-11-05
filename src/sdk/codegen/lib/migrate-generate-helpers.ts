import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fillMarkedSections } from "./fill-marked-sections.ts";
import { CONTENT, type GenerateEntry } from "./generate-result.ts";
import { resolveDatasourceDialects } from "./deterministic-project.ts";
import { isMultiLanguage } from "./declared-languages.ts";
import type { MigrateRenderOptions } from "./migrate-scripts-generate-types.ts";

/** The one bespoke migrate flag generate.mjs forwards to the generator; its value is DB-sourced per language (rust `src/bin`, csharp `MigrateRunner`) via language_generator.generate_args. Lives here in a leaf module so each generate-migrate-scripts-<lang>.mjs can declare it as its `flags` export without a circular import. */
export const MIGRATE_DIR_FLAG = {
  flag: "--migrate-dir",
  target: "migrateDir",
  kind: "value",
  defaultValue: "migrate",
  placeholder: "<dir>",
  description:
    "Subdirectory for the migrate runner program (default: migrate).",
};

/** A whole-file CONTENT generate entry. */
export const content = (filename: string, contents: string) => ({
  kind: CONTENT,
  filename,
  contents,
});

/** Empty-migrations placeholders for a per-language migrate scaffold. Generated only for a single-lane build whose lane IS the shared sql root; in a multi-language build the shared sql step owns and fills `sql/<dialect>/migrations`, so a lane-relative gitkeep would wrongly spawn `<lang>/sql`. */
export function gitkeepEntries(
  dialects: string[],
  settings: Parameters<typeof isMultiLanguage>[0],
) {
  if (isMultiLanguage(settings)) return [];
  return dialects.map((dialect) =>
    content(`sql/${dialect}/migrations/.gitkeep`, ""),
  );
}

/** Template helpers rooted at a language's `create-backend-app` templates dir (subpath segments below `scripts/templates/create-backend-app`). `read(name)` returns raw text; `composed(name, sections)` fills its `DIALECT_*` marked sections at generate time. */
const DEFAULT_TEMPLATES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates",
);

function runnerTemplatesAt(templatesDir: string, ...subpath: string[]) {
  const dir = resolve(templatesDir, "create-backend-app", ...subpath);
  const read = (name: string) => readFile(resolve(dir, name), "utf8");
  return {
    read,
    composed: async (
      name: string,
      sections: Parameters<typeof fillMarkedSections>[1],
    ) => fillMarkedSections(await read(name), sections),
  };
}

export function runnerTemplates(...subpath: string[]) {
  return runnerTemplatesAt(DEFAULT_TEMPLATES_DIR, ...subpath);
}

/** Bind the runner-template reader to a pack-owned `templates` dir, so a language pack reads its own migrate templates instead of the SDK's. */
export function makeRunnerTemplates(templatesDir: string) {
  return (...subpath: string[]) => runnerTemplatesAt(templatesDir, ...subpath);
}

export interface MigrateGenerateArgs {
  inputs: MigrateRenderOptions["inputs"];
  settings: MigrateRenderOptions["settings"];
  args?: { migrateDir?: string; combined?: boolean; dialects?: string[] };
}

/** Build a self-describing catalog-runner `generate` for a migrate language: resolve the configured (deployment) SQL dialects from settings, then hand the language's whole-scaffold render fn `{ migrateDir, dialects, inputs, settings }`. The render fn adds the sqlite runner lane itself (via `withSqliteDialect`) so `--provider sqlite` works in verify while the `.env`/docker defaults stay on the configured dialects. `migrateDir` comes from the DB-sourced `--migrate-dir` arg (rust `src/bin`, csharp `MigrateRunner`) via `generate.mjs`, defaulting to `migrate`. Returns native `entries` (a CONTENT + PATCH mix), so each module also exports `entriesNative = true`. The render fn is a local closure, never captured across an import cycle. */
export function makeMigrateGenerate(
  renderEntries: (args: MigrateRenderOptions) => Promise<GenerateEntry[]>,
) {
  return async function generate({ inputs, settings, args }: MigrateGenerateArgs) {
    const dialects = resolveDatasourceDialects(
      args ?? {},
      settings as Parameters<typeof resolveDatasourceDialects>[1],
    );
    return {
      entries: await renderEntries({
        migrateDir: args?.migrateDir ?? "migrate",
        dialects,
        inputs,
        settings,
        combined: args?.combined === true,
      }),
    };
  };
}
