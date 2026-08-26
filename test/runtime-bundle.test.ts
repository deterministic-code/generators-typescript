import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  applyBundledPackageJson,
  bundledRuntimeEntries,
  resolveRuntimeBundleDir,
  runtimePackageVersion,
} from "../src/runtime-bundle.ts";

describe("runtime-bundle", () => {
  it("reads the runtime package version", async () => {
    assert.equal(await runtimePackageVersion(), "0.0.7");
  });

  it("resolves a built runtime without requiring a manual build step", async () => {
    const dir = await resolveRuntimeBundleDir();
    assert.ok(dir.endsWith("runtime/dist") || dir.endsWith("runtime-bundle"));
    const entries = await bundledRuntimeEntries(dir);
    const names = entries.map((e) => e.filename);
    assert.ok(names.includes("_deterministic/app.js"), names.join("\n"));
    assert.ok(names.includes("_deterministic/routes.js"), names.join("\n"));
  });

  it("emits js, maps, and declarations and skips cjs", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-bundle-"));
    await mkdir(join(root, "repositories"));
    await writeFile(join(root, "app.js"), "export const createBackendApp = 1;\n");
    await writeFile(join(root, "app.d.ts"), "export const createBackendApp: number;\n");
    await writeFile(join(root, "app.js.map"), "{}\n");
    await writeFile(join(root, "app.cjs"), "module.exports = {};\n");
    await writeFile(join(root, "repositories", "sqlserver.js"), "export {};\n");
    const entries = await bundledRuntimeEntries(root);
    const names = entries.map((e) => e.filename).sort();
    assert.deepEqual(names, [
      "_deterministic/app.d.ts",
      "_deterministic/app.js",
      "_deterministic/app.js.map",
      "_deterministic/repositories/sqlserver.js",
    ]);
    const app = entries.find((e) => e.filename === "_deterministic/app.js");
    assert.equal(app?.kind, "content");
    if (app?.kind === "content") {
      assert.match(app.contents, /createBackendApp/);
    }
  });

  it("rewrites package.json for bundled mode", async () => {
    const pkg = JSON.parse(
      await applyBundledPackageJson(
        JSON.stringify({
          scripts: { build: "tsc", test: "vitest run" },
          dependencies: {
            "@deterministic-code/deterministic": "^0.0.7",
            zod: "^3.23.8",
          },
          allowScripts: {
            "@deterministic-code/deterministic": true,
            "better-sqlite3": true,
          },
        }),
      ),
    );
    assert.equal(pkg.dependencies["@deterministic-code/deterministic"], undefined);
    assert.equal(pkg.allowScripts["@deterministic-code/deterministic"], undefined);
    assert.equal(pkg.dependencies["better-sqlite3"], "^13.0.3");
    assert.equal(pkg.dependencies.express, "^4.21.0");
    assert.equal(pkg.dependencies.zod, "^3.23.8");
    assert.equal(
      pkg.scripts.build,
      "tsc && cp -R _deterministic dist/_deterministic",
    );
    assert.equal(pkg.scripts.test, "vitest run");
    assert.equal(pkg.allowScripts["better-sqlite3"], true);
    assert.equal(pkg.overrides["better-sqlite3"], undefined);
  });
});
