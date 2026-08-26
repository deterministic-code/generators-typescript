import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-backend-app.ts";

const entryBody = (entry: GenerateEntry): string =>
  "contents" in entry ? String(entry.contents) : entry.content;

const lastByName = (entries: GenerateEntry[]): Map<string, GenerateEntry> => {
  const map = new Map<string, GenerateEntry>();
  for (const entry of entries) map.set(entry.filename, entry);
  return map;
};

const uniqueNames = (entries: GenerateEntry[]): string[] =>
  [...new Set(entries.map((e) => e.filename))].sort();

const kindsOf = (entries: GenerateEntry[], filename: string): string[] =>
  entries.filter((e) => e.filename === filename).map((e) => e.kind);

const requireEntry = (
  map: Map<string, GenerateEntry>,
  filename: string,
): GenerateEntry => {
  const entry = map.get(filename);
  assert.ok(entry, `missing generate entry: ${filename}`);
  return entry;
};

describe("generate", () => {
  let entries: GenerateEntry[] = [];
  let byName = new Map<string, GenerateEntry>();

  before(async () => {
    entries = await generate({
      reader: memoryReader({}),
      settings: { application_name: "catalog-api" },
    });
    byName = lastByName(entries);
  });

  it("starts from minimal content then patches and adds deterministic files", () => {
    assert.deepEqual(uniqueNames(entries), [
      ".dockerignore",
      ".env",
      ".env.example",
      ".gitignore",
      "Dockerfile",
      "__tests__/appBoot.test.ts",
      "__tests__/health.test.ts",
      "app.ts",
      "docker-compose.yml",
      "package.json",
      "scripts/entrypoint.sh",
      "server.ts",
      "tsconfig.json",
      "vitest.config.ts",
    ]);
    assert.deepEqual(kindsOf(entries, "app.ts"), ["content", "patch"]);
    assert.deepEqual(kindsOf(entries, "package.json"), ["content", "patch"]);
    assert.deepEqual(kindsOf(entries, "server.ts"), ["content"]);
    assert.deepEqual(kindsOf(entries, "tsconfig.json"), ["content"]);
    const tsconfig = JSON.parse(entryBody(requireEntry(byName, "tsconfig.json")));
    assert.deepEqual(tsconfig.include, [
      "app.ts",
      "server.ts",
      "types/**/*.ts",
      "services/**/*.ts",
      "routes/**/*.ts",
      "perf-server.ts",
    ]);
    assert.deepEqual(kindsOf(entries, "__tests__/health.test.ts"), ["content"]);
    assert.deepEqual(kindsOf(entries, "Dockerfile"), ["patch"]);
    for (const filename of uniqueNames(entries)) {
      assert.equal(filename.startsWith("typescript/"), false, filename);
      assert.equal(filename.startsWith("backend/"), false, filename);
      assert.equal(filename.startsWith("features/"), false, filename);
      assert.equal(filename.startsWith("_deterministic/"), false, filename);
    }
    const dockerignore = requireEntry(byName, ".dockerignore");
    assert.equal(dockerignore.kind, "patch");
    assert.equal(
      "section" in dockerignore ? dockerignore.section : undefined,
      undefined,
    );
    assert.equal(entryBody(dockerignore), "node_modules");
  });

  it("renders app.ts against the npm library", () => {
    const app = entryBody(requireEntry(byName, "app.ts"));
    assert.equal(requireEntry(byName, "app.ts").kind, "patch");
    assert.match(
      app,
      /from "@deterministic-code\/deterministic\/app"/,
    );
    assert.doesNotMatch(app, /app-wiring/);
    assert.doesNotMatch(app, /composeRouter/);
    assert.doesNotMatch(app, /customModulePaths:/);
    assert.match(app, /BEGIN APP_CUSTOM_MODULE_PATHS/);
    assert.doesNotMatch(app, /_deterministic\/app/);
    assert.match(app, /BEGIN APP_DB_IMPORTS/);
    assert.match(app, /BEGIN APP_BEFORE_HOOK/);
    assert.match(app, /BEGIN APP_AFTER_HOOK/);
    assert.match(app, /export async function CreateBackendApp/);
  });

  it("renders server.ts with the typescript lane port and application name", () => {
    const server = entryBody(requireEntry(byName, "server.ts"));
    assert.equal(requireEntry(byName, "server.ts").kind, "content");
    assert.match(server, /process\.env\.PORT \?\? 4001/);
    assert.match(server, /catalog-api listening on http:\/\/localhost:/);
    assert.match(server, /await CreateBackendApp\(\)/);
    assert.doesNotMatch(server, /\.then\(/);
    assert.match(server, /app\.listen\(port\)/);
  });

  it("renders package.json for the npm library, not bundled runtime deps", () => {
    const pkg = JSON.parse(entryBody(requireEntry(byName, "package.json")));
    assert.equal(pkg.name, "catalog-api");
    assert.equal(pkg.type, "module");
    assert.equal(
      pkg.dependencies["@deterministic-code/deterministic"],
      "^0.0.7",
    );
    assert.equal(pkg.dependencies.express, undefined);
    assert.equal(pkg.allowScripts.esbuild, true);
    assert.equal(pkg.allowScripts["better-sqlite3"], true);
    assert.equal(pkg.allowScripts["@deterministic-code/deterministic"], true);
    assert.equal(pkg.allowScripts["core-js"], true);
    assert.equal(pkg.allowScripts["@scarf/scarf"], true);
    assert.equal(pkg.overrides["better-sqlite3"], "^13.0.3");
    assert.equal(pkg.overrides.glob, "^13.0.6");
    assert.equal(pkg.devDependencies.supertest, "^7.0.0");
    assert.equal(pkg.devDependencies["@types/supertest"], "^6.0.2");
    assert.equal(pkg.devDependencies["@faker-js/faker"], undefined);
  });

  it("copies the project from the image root, not a language lane", () => {
    const dockerfile = entryBody(requireEntry(byName, "Dockerfile"));
    assert.match(dockerfile, /^COPY package\*\.json tsconfig\.json \.\/$/m);
    assert.match(dockerfile, /^COPY \. \.\/$/m);
    assert.doesNotMatch(dockerfile, /typescript\//);
    assert.doesNotMatch(dockerfile, /COPY deterministic /);
    assert.doesNotMatch(dockerfile, /_deterministic/);
  });

  it("renders a root compose service without a lane dockerfile path", () => {
    const compose = entryBody(requireEntry(byName, "docker-compose.yml"));
    assert.match(compose, /^app:/m);
    assert.match(compose, /HOST_PORT/);
    assert.match(compose, /deterministic\.language=typescript/);
    assert.doesNotMatch(compose, /dockerfile:/);
    assert.doesNotMatch(compose, /typescript\/Dockerfile/);
  });

  it("emits health and boot tests from templates", () => {
    const health = entryBody(requireEntry(byName, "__tests__/health.test.ts"));
    assert.match(health, /GET \/api\/health/);
    assert.match(health, /await CreateBackendApp\(\)/);
    assert.doesNotMatch(health, /\.then\(/);
    const boot = entryBody(requireEntry(byName, "__tests__/appBoot.test.ts"));
    assert.match(boot, /CreateBackendApp/);
    assert.match(boot, /await CreateBackendApp\(\)/);
  });

  it("treats omitted app_generate_complexity as deterministic", async () => {
    const omitted = await generate({
      reader: memoryReader({}),
      settings: { application_name: "catalog-api" },
    });
    const explicit = await generate({
      reader: memoryReader({}),
      settings: {
        application_name: "catalog-api",
        app_generate_complexity: "deterministic",
      },
    });
    assert.deepEqual(
      omitted.map((e) => `${e.kind}:${e.filename}`),
      explicit.map((e) => `${e.kind}:${e.filename}`),
    );
  });

  it("rejects an unknown app_generate_complexity", async () => {
    await assert.rejects(
      () =>
        generate({
          reader: memoryReader({}),
          settings: {
            application_name: "catalog-api",
            app_generate_complexity: "full",
          },
        }),
      /settings\.app_generate_complexity must be "minimal" or "deterministic"/,
    );
  });
});

describe("generate minimal", () => {
  let entries: GenerateEntry[] = [];
  let byName = new Map<string, GenerateEntry>();

  before(async () => {
    entries = await generate({
      reader: memoryReader({}),
      settings: {
        application_name: "catalog-api",
        app_generate_complexity: "minimal",
      },
    });
    byName = lastByName(entries);
  });

  it("emits only content files for the boot and health-check scaffold", () => {
    assert.deepEqual(
      uniqueNames(entries),
      [
        "__tests__/health.test.ts",
        "app.ts",
        "package.json",
        "server.ts",
        "tsconfig.json",
      ],
    );
    for (const entry of entries) {
      assert.equal(entry.kind, "content", entry.filename);
    }
  });

  it("omits docker, vitest, migrate hooks, and extra test tooling", () => {
    const app = entryBody(requireEntry(byName, "app.ts"));
    assert.doesNotMatch(app, /BEGIN APP_DB_IMPORTS/);
    assert.doesNotMatch(app, /BEGIN APP_BEFORE_HOOK/);
    assert.doesNotMatch(app, /@deterministic-code\/deterministic/);
    assert.doesNotMatch(app, /createDeterministicApp/);
    assert.doesNotMatch(app, /settingsConfig/);
    const pkg = JSON.parse(entryBody(requireEntry(byName, "package.json")));
    assert.equal(pkg.name, "catalog-api");
    assert.equal(pkg.dependencies, undefined);
    assert.deepEqual(Object.keys(pkg.devDependencies).sort(), [
      "@types/node",
      "typescript",
    ]);
    assert.equal(
      pkg.scripts.test,
      "node --experimental-strip-types --test __tests__/health.test.ts",
    );
    const tsconfig = JSON.parse(entryBody(requireEntry(byName, "tsconfig.json")));
    assert.deepEqual(tsconfig.include, ["app.ts", "server.ts"]);
    const health = entryBody(requireEntry(byName, "__tests__/health.test.ts"));
    assert.match(health, /GET \/api\/health/);
    assert.match(health, /from "node:test"/);
    const server = entryBody(requireEntry(byName, "server.ts"));
    assert.match(server, /await CreateBackendApp\(\)/);
    assert.match(server, /createServer\(app\)/);
    assert.doesNotMatch(server, /\.then\(/);
  });
});

describe("generate by-feature", () => {
  it("covers features in the scaffold tsconfig include", async () => {
    const entries = await generate({
      reader: memoryReader({}),
      settings: {
        application_name: "catalog-api",
        "other.organize_by_feature": "true",
      },
    });
    assert.deepEqual(kindsOf(entries, "tsconfig.json"), ["content"]);
    const tsconfig = JSON.parse(entryBody(requireEntry(lastByName(entries), "tsconfig.json")));
    assert.deepEqual(tsconfig.include, [
      "app.ts",
      "server.ts",
      "features/**/*.ts",
      "perf-server.ts",
    ]);
  });
});

describe("generate bundled", () => {
  let entries: GenerateEntry[] = [];
  let byName = new Map<string, GenerateEntry>();

  before(async () => {
    entries = await generate({
      reader: memoryReader({}),
      settings: {
        application_name: "catalog-api",
        "languages.typescript.library_reference_mode": "bundled",
      },
    });
    byName = lastByName(entries);
  });

  it("vendors the compiled runtime under _deterministic", () => {
    const names = uniqueNames(entries);
    assert.ok(names.includes("_deterministic/app.js"), names.join("\n"));
    assert.ok(names.includes("_deterministic/app.d.ts"), names.join("\n"));
    assert.ok(names.includes("_deterministic/routes.js"), names.join("\n"));
    assert.ok(names.includes("_deterministic/routes.d.ts"), names.join("\n"));
    assert.ok(
      names.includes("_deterministic/services.js"),
      names.join("\n"),
    );
    const appJs = requireEntry(byName, "_deterministic/app.js");
    assert.equal(appJs.kind, "content");
    assert.match(entryBody(appJs), /createBackendApp/);
  });

  it("points app.ts at the vendored runtime", () => {
    const app = entryBody(requireEntry(byName, "app.ts"));
    assert.match(app, /from "\.\/_deterministic\/app\.js"/);
    assert.doesNotMatch(app, /@deterministic-code\/deterministic\/app/);
  });

  it("renders package.json with runtime deps instead of the npm library", () => {
    const pkg = JSON.parse(entryBody(requireEntry(byName, "package.json")));
    assert.equal(pkg.dependencies["@deterministic-code/deterministic"], undefined);
    assert.equal(pkg.allowScripts["@deterministic-code/deterministic"], undefined);
    assert.equal(pkg.dependencies.express, "^4.21.0");
    assert.equal(pkg.dependencies.zod, "^3.23.8");
    assert.equal(
      pkg.scripts.build,
      "tsc && cp -R _deterministic dist/_deterministic",
    );
  });
});
