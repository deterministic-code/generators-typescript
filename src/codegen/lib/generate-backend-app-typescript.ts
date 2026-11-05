import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SECTION_MARKERS } from "../../sdk/section-markers.ts";
import {
  DEV_PORTS,
  buildAppModel,
} from "../../sdk/create-backend-app-model.ts";
import {
  makeChunkLoader,
  applyTokens,
  renderTemplate,
} from "../../sdk/codegen/lib/chunk-loader.ts";
import { PACK_TEMPLATES_DIR } from "../../pack-root.ts";

const { loadChunk } = makeChunkLoader(PACK_TEMPLATES_DIR);
import { pathExists } from "../../sdk/path-exists.ts";
import {
  readSettingsWithDefault,
  resolveLibraryReferenceMode,
  type ParsedSettings,
} from "../../sdk/read-settings.ts";
import { normalizeDialect } from "../../sdk/lib/generate-sql.ts";
import { namesForSettings } from "../../sdk/codegen/lib/ts-codegen-naming.ts";
import { resolveCustomGeneratePath } from "./generate-services-typescript.ts";
import { resolveCustomRoutePath } from "./generate-routes-typescript.ts";
import { generateTestApp } from "./generate-test-app-typescript.ts";
import { datasourceSettingsForSettings } from "../../sdk/codegen/lib/ts-datasource-settings.ts";
import {
  COMPOSE_FILENAME,
  renderTypescriptComposeService,
} from "../../sdk/codegen/lib/compose-services.ts";
import {
  REPO_ROOT,
  firstExistingDir,
} from "../../sdk/codegen/lib/artifact-paths.ts";
import {
  CONTENT,
  PATCH,
  type GenerateEntry,
} from "../../sdk/codegen/lib/generate-result.ts";
import {
  DOCKERIGNORE_TRIGGER,
  dockerignoreSection,
} from "@deterministic-code/patch-merger";
import { loadBackendAppInputs } from "../../sdk/codegen/lib/backend-app-inputs.ts";
import { makeBackendAppGenerate } from "../../sdk/codegen/lib/backend-app-generate-helpers.ts";
import { isMultiLanguage } from "../../sdk/codegen/lib/declared-languages.ts";
import {
  backendLaneDir,
  COMBINED_FLAG,
} from "../../sdk/codegen/lib/backend-lane.ts";
import type { CodegenNames } from "../../sdk/codegen-naming.ts";

type AppModel = ReturnType<typeof buildAppModel>;

interface BackendAppOptions {
  libraryReferenceMode?: string;
  multiLanguage?: boolean;
  laneDir?: string;
}

interface AppTsOptions {
  libraryReferenceMode?: string;
  customModulePaths?: Record<string, string>;
  organizeByFeature?: boolean;
}

interface MigrationLayout {
  migrationsPath(dialect: string): string;
}

interface BackendAppInputs {
  routesDoc: unknown;
  servicesDoc: unknown;
  datasourceTypesDoc: unknown;
  viewTypesDoc: unknown;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(PACK_TEMPLATES_DIR, "create-backend-app");

const APP_TS_CHUNK = await loadChunk("typescript", "app");
const SERVER_TS_CHUNK = await loadChunk("typescript", "server");
const APP_TS_DB_HOOK_IMPORTS_CHUNK = await loadChunk(
  "typescript",
  "app_ts_db_hook_imports",
);
const APP_TS_BEFORE_HOOK_CHUNK = await loadChunk(
  "typescript",
  "app_ts_before_hook",
);
const TEST_APP_DB_CONN_CHUNK = await loadChunk(
  "typescript",
  "test_app_db_conn",
);

export const TEST_DB_RELATIVE_PATH = ".test/prebuilt.sqlite";

export function buildAppTsDbHookImportsBlock(
  libraryReferenceMode: string,
): string {
  const libImport =
    libraryReferenceMode === "bundled"
      ? "./_deterministic/app.js"
      : "@deterministic-code/deterministic/app";
  return applyTokens(APP_TS_DB_HOOK_IMPORTS_CHUNK, { libImport }) + "\n";
}

export function buildAppTsBeforeHookBlock(): string {
  return APP_TS_BEFORE_HOOK_CHUNK + "\n";
}

export function buildAppTsAfterHookBlock(): string {
  return "";
}

export function buildTestAppDbConnBlock(libraryReferenceMode: string): string {
  // test-app.ts lives in __tests__/, so the bundled specifier needs one more ".." than app.ts's.
  const libImport =
    libraryReferenceMode === "bundled"
      ? "../_deterministic/app.js"
      : "@deterministic-code/deterministic/app";
  return applyTokens(TEST_APP_DB_CONN_CHUNK, { libImport });
}

export function buildMigrateScripts(
  migrateDir: string,
  dialects: string[],
  layout: MigrationLayout,
): Record<string, string> {
  const list = dialects.length > 0 ? dialects : ["sqlite"];
  const defaultDialect = list.includes("sqlite") ? "sqlite" : list[0];
  const migrationsPath = (dialect: string) => layout.migrationsPath(dialect);
  const cmds = (dialect: string) => ({
    setup: `node --env-file-if-exists=.env ${migrateDir}/migrate-setup.mjs --provider ${dialect}`,
    up: `node --env-file-if-exists=.env ${migrateDir}/migrate-up.mjs --provider ${dialect} --migrate-path ${migrationsPath(dialect)}`,
    down: `node --env-file-if-exists=.env ${migrateDir}/migrate-down.mjs --provider ${dialect} --migrate-path ${migrationsPath(dialect)}`,
  });
  const out: Record<string, string> = {};
  if (dialects.length > 0) {
    for (const dialect of list) {
      const c = cmds(dialect);
      out[`migrate:${dialect}:setup`] = c.setup;
      out[`migrate:${dialect}`] = c.up;
      out[`migrate:${dialect}:down`] = c.down;
    }
  }
  const def = cmds(defaultDialect);
  out["migrate:setup"] = def.setup;
  out.migrate = def.up;
  out["migrate:down"] = def.down;
  return out;
}

export function buildPretestScript(
  migrateDir: string,
  libraryReferenceMode: string,
  layout: MigrationLayout,
): string {
  const prefix =
    libraryReferenceMode === "bundled"
      ? "npm run build && cp -r _deterministic dist/_deterministic && "
      : "";
  // Pass the resolved --migrate-path so migrate-setup forwards it to the migrate-up it spawns (--and-up only forwards a path it was given). The default is the host lane-relative root (`../sql` multi-language, `sql` otherwise); TEST_MIGRATIONS_DIR overrides it when `npm test` runs inside the container (docker_test), where the flattened tree lives at the absolute /app/sql the entrypoint exports — `../sql` from WORKDIR /app would resolve to an empty /sql and leave the prebuilt test DB tableless.
  const migratePath = `\${TEST_MIGRATIONS_DIR:-${layout.migrationsPath("sqlite")}}`;
  return `${prefix}node ${migrateDir}/migrate-setup.mjs --provider sqlite --connection $npm_package_config_test_db --migrate-path ${migratePath} --and-up`;
}

function toSpecifier(generatePath: string): string {
  return `./${generatePath.replace(/\.ts$/, "")}`;
}

function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

/** The relative custom-impl `module:` (`./…`) on a service entry or route def, or null when it isn't a relocatable custom entry. */
function customEntryModule(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const mod = (entry as { module?: unknown }).module;
  return typeof mod === "string" && mod.startsWith(".") ? mod : null;
}

/** The single `{ <name>: def }` route def object, or null when the entry isn't a single-keyed route. */
function routeEntryDef(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== "object") return null;
  const keys = Object.keys(entry);
  if (keys.length !== 1) return null;
  const def = (entry as Record<string, unknown>)[keys[0]];
  return def && typeof def === "object"
    ? (def as Record<string, unknown>)
    : null;
}

interface CustomModulePathsInput {
  servicesDoc: { services?: unknown } | null;
  routesDoc: { routes?: unknown } | null;
  names: CodegenNames;
}

/** The `original module: → relocated features/<entity>/custom/…` map the generated `app.ts` hands `createBackendApp`, so the shipped `deterministic/` contract stays the verbatim, layout-neutral input while the by-feature runtime still loads the moved custom impls. Empty in flat layout. Derived through `CodegenLayout` via `resolveCustomGeneratePath`/`resolveCustomRoutePath`, so casing/placement stay SDK-owned. */
export function buildCustomModulePaths({
  servicesDoc,
  routesDoc,
  names,
}: CustomModulePathsInput): Record<string, string> {
  const map: Record<string, string> = {};
  const add = (mod: string, target: string) => {
    if (map[mod] !== undefined && map[mod] !== target) {
      throw new Error(
        `by-feature custom module "${mod}" resolves to both "${map[mod]}" and "${target}" — declare distinct module paths per entry`,
      );
    }
    map[mod] = target;
  };
  for (const entry of asArray(servicesDoc?.services)) {
    const mod = customEntryModule(entry);
    if (mod) {
      const path = resolveCustomGeneratePath(
        entry as Parameters<typeof resolveCustomGeneratePath>[0],
        names,
        true,
      );
      add(mod, toSpecifier(path));
    }
  }
  for (const entry of asArray(routesDoc?.routes)) {
    const def = routeEntryDef(entry);
    const mod = def && customEntryModule(def);
    if (mod) {
      const path = resolveCustomRoutePath(
        entry as Parameters<typeof resolveCustomRoutePath>[0],
        names,
        true,
      );
      add(mod, toSpecifier(path));
    }
  }
  return map;
}

function renderCustomModulePathsLiteral(
  map: Record<string, string> | undefined,
): string {
  const keys = Object.keys(map ?? {});
  if (keys.length === 0) return "";
  const body = keys
    .map((k) => `      ${JSON.stringify(k)}: ${JSON.stringify(map![k])},`)
    .join("\n");
  return `\n    customModulePaths: {\n${body}\n    },`;
}

export function renderAppTs(_model: AppModel, opts: AppTsOptions = {}): string {
  const libImport =
    opts.libraryReferenceMode === "bundled"
      ? "./_deterministic/app.js"
      : "@deterministic-code/deterministic/app";
  const composeRouterImport = opts.organizeByFeature
    ? "./features/app-wiring.js"
    : "./routes/generated/app-wiring.js";
  return (
    applyTokens(APP_TS_CHUNK, {
      libImport,
      composeRouterImport,
      APP_CUSTOM_MODULE_PATHS: renderCustomModulePathsLiteral(
        opts.customModulePaths,
      ),
      APP_DB_IMPORTS_START: SECTION_MARKERS.APP_DB_IMPORTS.start,
      APP_DB_IMPORTS_END: SECTION_MARKERS.APP_DB_IMPORTS.end,
      APP_BEFORE_HOOK_START: SECTION_MARKERS.APP_BEFORE_HOOK.start,
      APP_BEFORE_HOOK_END: SECTION_MARKERS.APP_BEFORE_HOOK.end,
      APP_AFTER_HOOK_START: SECTION_MARKERS.APP_AFTER_HOOK.start,
      APP_AFTER_HOOK_END: SECTION_MARKERS.APP_AFTER_HOOK.end,
    }) + "\n"
  );
}

export function renderServerTs(appName: string): string {
  return (
    applyTokens(SERVER_TS_CHUNK, {
      devPort: DEV_PORTS.typescript,
      appName,
    }) + "\n"
  );
}

export function renderTypescriptEnvSection(): string {
  return `PORT=${DEV_PORTS.typescript}\n`;
}

const BUNDLED_LIBRARY_RUNTIME_DEPS: Record<string, string> = {
  cors: "^2.8.5",
  express: "^4.21.0",
  helmet: "^8.0.0",
  "js-yaml": "^4.1.1",
  jsonwebtoken: "^9.0.2",
  pluralize: "^8.0.0",
  zod: "^3.23.8",
};

export async function renderPackageJson(
  model: AppModel,
  _dialects: string[] = [],
  opts: BackendAppOptions = {},
): Promise<string> {
  const templatePath = resolve(templatesDir, "package.json.tmpl");
  const content = await renderTemplate(templatePath, {
    appName: model.appName,
  });
  const pkg = JSON.parse(content);
  pkg.dependencies = pkg.dependencies ?? {};
  if (opts.libraryReferenceMode === "bundled") {
    delete pkg.dependencies["@deterministic-code/deterministic"];
    for (const [name, version] of Object.entries(
      BUNDLED_LIBRARY_RUNTIME_DEPS,
    )) {
      pkg.dependencies[name] = version;
    }
  }
  return JSON.stringify(pkg, null, 2) + "\n";
}

const ALL_DIALECT_DRIVER_MODULES = [
  { module: "pg", usedBy: "postgres" },
  { module: "mysql2/promise", usedBy: "mysql" },
  { module: "mssql", usedBy: "sqlserver" },
  { module: "oracledb", usedBy: "oracle" },
];

export function renderDbDriverShims(dialects: string[] = []): string | null {
  const enabledModules = new Set<string>();
  for (const dialect of dialects) {
    if (dialect === "postgres") enabledModules.add("pg");
    if (dialect === "mysql") enabledModules.add("mysql2/promise");
    if (dialect === "sqlserver") enabledModules.add("mssql");
    if (dialect === "oracle") enabledModules.add("oracledb");
  }
  const stubLines: string[] = [];
  for (const { module } of ALL_DIALECT_DRIVER_MODULES) {
    if (enabledModules.has(module)) continue;
    stubLines.push(`declare module '${module}' { const x: any; export = x; }`);
  }
  if (stubLines.length === 0) return null;
  return `// Ambient stubs for DB driver modules the rolled-up library .d.ts references but this project does not install — keeps \`tsc --noEmit\` happy without bloating node_modules.
${stubLines.join("\n")}\n`;
}

export async function renderDockerfile(
  opts: BackendAppOptions = {},
): Promise<string> {
  const templatePath = resolve(templatesDir, "Dockerfile.tmpl");
  const bundled = opts.libraryReferenceMode === "bundled";
  // COPY . ./ takes the whole generated output (whatever steps ran); tsc preserves source-relative imports verbatim into dist/, so bundled mode mirrors _deterministic/ into dist/_deterministic/ for runtime resolution.
  const deterministicLibraryRuntimeCopy = bundled
    ? `\nRUN cp -r _deterministic dist/_deterministic`
    : "";
  // When output is nested under a lane dir (multi-lang `<lang>/` or combined `backend/`) the root compose sets `context: .` and `dockerfile: ./<lane>Dockerfile`, so the lane-relative COPY lines carry the lane prefix. Root-shared trees are reached explicitly from the root context: sql/ via the migrate COPY, and deterministic/ (the runtime service-spec YAML) here — flat single-lang single-tier rides `COPY . ./`.
  const laneDir = opts.laneDir ?? "";
  const deterministicCopy = laneDir
    ? "COPY deterministic ./deterministic\n"
    : "";
  return await renderTemplate(templatePath, {
    tsPrefix: laneDir,
    deterministicCopy,
    workDir: "/app",
    deterministicLibraryRuntimeCopy,
    apkClientsBegin: SECTION_MARKERS.APK_CLIENTS.start,
    apkClientsEnd: SECTION_MARKERS.APK_CLIENTS.end,
    migrateCopyBegin: SECTION_MARKERS.MIGRATE_COPY.start,
    migrateCopyEnd: SECTION_MARKERS.MIGRATE_COPY.end,
  });
}

export async function renderTsConfig(
  _model: AppModel,
  opts: BackendAppOptions = {},
): Promise<string> {
  const templatePath = resolve(templatesDir, "tsconfig.json.tmpl");
  const content = await renderTemplate(templatePath, {});
  if (opts.libraryReferenceMode !== "bundled") return content;
  const parsed = JSON.parse(content);
  const exclude = Array.isArray(parsed.exclude) ? [...parsed.exclude] : [];
  if (!exclude.includes("_deterministic/**")) exclude.push("_deterministic/**");
  parsed.exclude = exclude;
  return JSON.stringify(parsed, null, 2) + "\n";
}

export async function renderHealthCheckService(): Promise<string> {
  const templatePath = resolve(templatesDir, "health-check-service.ts.tmpl");
  return await renderTemplate(templatePath, {});
}

function renderTypescriptGitignoreSection(): string {
  return ["node_modules/", "dist/", "*.tgz", ".env.local", "*.log", ""].join(
    "\n",
  );
}

async function renderVitestConfig(): Promise<string> {
  const templatePath = resolve(templatesDir, "vitest.config.ts.tmpl");
  return await renderTemplate(templatePath, {});
}

async function renderHealthSmokeTest(): Promise<string> {
  const templatePath = resolve(templatesDir, "health.test.ts.tmpl");
  return await renderTemplate(templatePath, {});
}

async function renderAppBootTest(): Promise<string> {
  const templatePath = resolve(templatesDir, "app-boot.test.ts.tmpl");
  return await renderTemplate(templatePath, {});
}

export async function renderEntrypointScript(): Promise<string> {
  const templatePath = resolve(templatesDir, "entrypoint.sh");
  return await renderTemplate(templatePath, {
    migrateHookBegin: SECTION_MARKERS.MIGRATE_HOOK.start,
    migrateHookEnd: SECTION_MARKERS.MIGRATE_HOOK.end,
  });
}

function routesDeclareHealthEndpoint(routesDoc: unknown): boolean {
  const routes =
    routesDoc && typeof routesDoc === "object"
      ? (routesDoc as { routes?: unknown })
      : {};
  const routeList = Array.isArray(routes.routes) ? routes.routes : [];
  return routeList.some((entry: unknown) => {
    if (!entry || typeof entry !== "object") return false;
    return Object.values(entry).some(
      (def) =>
        def &&
        typeof def === "object" &&
        (def as { path?: unknown }).path === "/api/health",
    );
  });
}

async function resolveLibraryDistDir(rootDir: string): Promise<string> {
  return firstExistingDir(
    [
      join(
        rootDir,
        "node_modules",
        "@deterministic-code",
        "deterministic",
        "typescript",
        "dist",
      ),
      join(
        rootDir,
        "node_modules",
        "@deterministic-code",
        "deterministic",
        "dist",
      ),
      join(rootDir, "typescript", "dist"),
    ],
    `library_reference_mode=bundled requires @deterministic-code/deterministic to be built or installed.`,
  );
}

async function bundledDistEntries(): Promise<GenerateEntry[]> {
  const distDir = await resolveLibraryDistDir(REPO_ROOT);
  const out: GenerateEntry[] = [];
  const walk = async (dir: string, rel: string) => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(join(dir, ent.name), relPath);
        continue;
      }
      if (ent.name.endsWith(".cjs")) continue;
      out.push({
        kind: CONTENT,
        filename: `_deterministic/${relPath}`,
        contents: await readFile(join(dir, ent.name), "utf8"),
      });
    }
  };
  await walk(distDir, "");
  return out;
}

/** Container + local-dev scaffolding (Docker, compose, env, gitignore) — the deployment half of the TS backend, split from the app-source entries so each builder stays within the size budget. */
async function typescriptDeploymentEntries({
  o,
}: {
  o: BackendAppOptions;
}): Promise<GenerateEntry[]> {
  return [
    {
      kind: PATCH,
      filename: "Dockerfile",
      content: await renderDockerfile(o),
    },
    {
      kind: PATCH,
      filename: ".dockerignore",
      section: dockerignoreSection("typescript"),
      content: DOCKERIGNORE_TRIGGER,
    },
    {
      kind: PATCH,
      filename: "scripts/entrypoint.sh",
      content: await renderEntrypointScript(),
    },
    {
      kind: PATCH,
      filename: COMPOSE_FILENAME,
      content: renderTypescriptComposeService(
        // compose-services.mjs infers dockerfilePath as null from its default; the runtime accepts the string path.
        (o.laneDir
          ? { dockerfilePath: `./${o.laneDir}Dockerfile` }
          : {}) as unknown as Parameters<
          typeof renderTypescriptComposeService
        >[0],
      ),
    },
    { kind: PATCH, filename: ".env", content: renderTypescriptEnvSection() },
    {
      kind: PATCH,
      filename: ".env.example",
      content: renderTypescriptEnvSection(),
    },
    {
      kind: PATCH,
      filename: ".gitignore",
      content: renderTypescriptGitignoreSection(),
    },
  ];
}

interface ScaffoldEntriesInput {
  model: AppModel;
  dialects: string[];
  libraryReferenceMode: string;
  customModulePaths: Record<string, string>;
  multiLanguage: boolean;
  laneDir: string;
  organizeByFeature: boolean;
}

async function typescriptScaffoldEntries({
  model,
  dialects,
  libraryReferenceMode,
  customModulePaths,
  multiLanguage,
  laneDir,
  organizeByFeature,
}: ScaffoldEntriesInput): Promise<GenerateEntry[]> {
  const o: BackendAppOptions = { libraryReferenceMode, multiLanguage, laneDir };
  return [
    {
      kind: PATCH,
      filename: "app.ts",
      content: await renderAppTs(model, {
        ...o,
        customModulePaths,
        organizeByFeature,
      }),
    },
    {
      kind: CONTENT,
      filename: "server.ts",
      contents: renderServerTs(model.appName),
    },
    {
      kind: PATCH,
      filename: "package.json",
      content: await renderPackageJson(model, dialects, o),
    },
    {
      kind: CONTENT,
      filename: "tsconfig.json",
      contents: await renderTsConfig(model, o),
    },
    ...(await typescriptDeploymentEntries({ o })),
  ];
}

interface TestEntriesInput {
  inputs: BackendAppInputs;
  settings: ParsedSettings;
  libraryReferenceMode: string;
}

async function typescriptTestEntries({
  inputs,
  settings,
  libraryReferenceMode,
}: TestEntriesInput): Promise<GenerateEntry[]> {
  const entries: GenerateEntry[] = [
    {
      kind: CONTENT,
      filename: "vitest.config.ts",
      contents: await renderVitestConfig(),
    },
  ];
  if (routesDeclareHealthEndpoint(inputs.routesDoc)) {
    entries.push({
      kind: CONTENT,
      filename: "__tests__/health.test.ts",
      contents: await renderHealthSmokeTest(),
    });
  }
  entries.push({
    kind: CONTENT,
    filename: "__tests__/app-boot.test.ts",
    contents: await renderAppBootTest(),
  });
  const ds = datasourceSettingsForSettings(settings);
  const testAppFile = generateTestApp({
    datasourceData: inputs.datasourceTypesDoc,
    routesData: inputs.routesDoc,
    viewTypesData: inputs.viewTypesDoc,
    pluralizeTableNames: ds.pluralizeTableNames,
    datetime: ds.datetimeRepr,
    uuid: ds.uuidRepr,
    idType: ds.idType,
    libraryReferenceMode,
    organizeByFeature: settings.other.organizeByFeature === true,
  });
  entries.push({
    kind: PATCH,
    filename: join("__tests__", testAppFile.path),
    content: testAppFile.content,
  });
  return entries;
}

async function resolveTypescriptBackend(inputDir: string) {
  const settings = await readSettingsWithDefault(inputDir);
  const inputs = await loadBackendAppInputs(inputDir, settings);
  const dialects = (
    settings.backend.datasources.length > 0
      ? settings.backend.datasources
      : ["sqlite"]
  )
    .map((d: string) => normalizeDialect(d))
    .filter((d): d is Exclude<typeof d, null> => d !== null);
  const model = buildAppModel({
    ...inputs,
    applicationName: settings.applicationName,
    byFeature: settings.other.organizeByFeature === true,
  } as Parameters<typeof buildAppModel>[0]);
  return {
    inputs,
    settings,
    dialects,
    model,
    libraryReferenceMode: resolveLibraryReferenceMode(
      settings.languages,
      "typescript",
    ),
  };
}

interface GenerateArgs {
  input?: string;
  combined?: boolean;
}

export async function generateBackendApp(args: GenerateArgs): Promise<GenerateEntry[]> {
  if (!args.input) {
    throw new Error("create-backend-app (typescript): --input is required");
  }
  const inputDir = resolve(args.input);
  if (!(await pathExists(inputDir))) {
    throw new Error(
      `create-backend-app (typescript): input directory does not exist: ${inputDir}`,
    );
  }
  const { inputs, settings, dialects, model, libraryReferenceMode } =
    await resolveTypescriptBackend(inputDir);
  const multiLanguage = isMultiLanguage(settings);
  const laneDir = backendLaneDir({
    combined: args.combined === true,
    multiLanguage,
    language: "typescript",
  });
  const customModulePaths = settings.other.organizeByFeature
    ? buildCustomModulePaths({
        servicesDoc: inputs.servicesDoc as { services?: unknown } | null,
        routesDoc: inputs.routesDoc as { routes?: unknown } | null,
        names: namesForSettings(settings, "typescript"),
      })
    : {};
  const entries: GenerateEntry[] = [
    ...(await typescriptScaffoldEntries({
      model,
      dialects,
      libraryReferenceMode,
      customModulePaths,
      multiLanguage,
      laneDir,
      organizeByFeature: settings.other.organizeByFeature === true,
    })),
    ...(await typescriptTestEntries({
      inputs,
      settings,
      libraryReferenceMode,
    })),
  ];
  if (libraryReferenceMode === "bundled") {
    entries.push(...(await bundledDistEntries()));
  }
  return entries;
}

export const generate = makeBackendAppGenerate(generateBackendApp, "typescript");
export const entriesNative = true;
export const pinProjectRoot = true;
export const flags = [COMBINED_FLAG];
