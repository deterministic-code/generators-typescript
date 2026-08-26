import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-routes-e2e-test.ts";

const DS_YAML = `types:
  - user:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
`;

const ROUTES_YAML = `includes:
  - types:
      filter: 'tag == "view_type" || tag == "datasource_type"'
`;

const textOf = (entries: GenerateEntry[], path: string): string => {
  const hit = entries.find((e) => e.kind === "content" && e.filename === path);
  assert.ok(
    hit,
    `missing entry ${path}; got ${entries.map((e) => e.filename).join(", ")}`,
  );
  assert.equal(hit.kind, "content");
  return hit.contents;
};

describe("generate-routes-e2e-test", () => {
  it("emits a file-backed sqlite app integration test, not an in-memory db", async () => {
    const entries = await generate({
      reader: memoryReader({
        "types.yaml": DS_YAML,
        "routes.yaml": ROUTES_YAML,
      }),
      settings: {},
    });
    const body = textOf(entries, "__tests__/app.integration.test.ts");
    assert.match(body, /npm_package_config_test_db/);
    assert.match(body, /backend: "sqlite"/);
    assert.doesNotMatch(body, /backend: "memory"/);
    assert.match(body, /from "supertest"/);
    assert.match(body, /srcRoot: process\.cwd\(\)/);
    assert.match(body, /entity\.replace\(\/_\/g, "-"\)/);
    assert.doesNotMatch(body, /replace\(\/_\/g, "-"\)\}s/);
    assert.doesNotMatch(body, /customModulePaths:/);
  });

  it("remaps custom service modules under by-feature", async () => {
    const entries = await generate({
      reader: memoryReader({
        "types.yaml": DS_YAML,
        "routes.yaml": ROUTES_YAML,
        "services.yaml": `includes:
  - types:
      filter: tag == "view_type"
services:
  - name: ContactImportService
    module: ./services/contact-import-service
`,
      }),
      settings: {
        "other.organize_by_feature": "true",
        "languages.typescript.casing.file_names": "Pascal",
      },
    });
    const body = textOf(entries, "__tests__/app.integration.test.ts");
    assert.match(body, /customModulePaths: CUSTOM_MODULE_PATHS/);
    assert.match(
      body,
      /\.\/services\/contact-import-service": "\.\/features\/contactImportService\/custom\/ContactImportService"/,
    );
  });
});
