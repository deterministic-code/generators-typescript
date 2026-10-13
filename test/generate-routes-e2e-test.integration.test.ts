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
  it("emits a health-only app test without the deleted runtime", async () => {
    const entries = await generate({
      reader: memoryReader({
        "types.yaml": DS_YAML,
        "routes.yaml": ROUTES_YAML,
      }),
      settings: {},
    });
    const body = textOf(entries, "__tests__/app.integration.test.ts");
    assert.match(body, /GET \/api\/health/);
    assert.match(body, /CreateBackendApp/);
    assert.doesNotMatch(body, /createBackendApp/);
    assert.doesNotMatch(body, /@deterministic-code\/deterministic/);
    assert.doesNotMatch(body, /connectDatabase/);
    assert.doesNotMatch(body, /supertest/);
    assert.doesNotMatch(body, /customModulePaths/);
  });
});
