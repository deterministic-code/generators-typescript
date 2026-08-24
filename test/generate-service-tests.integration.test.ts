import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-service-tests.ts";

const DS_YAML = `types:
  - user:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
            size: 256
  - role:
      tags: [datasource_type, view_type, readonly_lookup]
      inherits: set
      fields:
        - name:
            type: string
  - sku:
      tags: [datasource_type, view_type]
      fields:
        - code:
            type: string
`;

const DATASOURCE = `includes:
  - types:
      filter: tag == "datasource_type"
types:
  - user:
      fields:
        - email:
            is_unique: true
  - role:
      fields:
        - name:
            is_unique: true
  - sku:
      fields:
        - code:
            is_fixed_id: true
`;

const SERVICES_YAML = `includes:
  - types:
      filter: 'tag == "view_type"'
services:
  - name: ReportService
`;

const NO_INCLUDES = `services:
  - name: ReportService
`;

const fixtureReader = (files: Record<string, string>) => memoryReader(files);

const yaml = {
  "types.yaml": DS_YAML,
  "datasource.yaml": DATASOURCE,
  "services.yaml": SERVICES_YAML,
};

const textOf = (entries: GenerateEntry[], path: string): string => {
  const hit = entries.find((e) => e.kind === "content" && e.filename === path);
  assert.ok(hit, `missing entry ${path}`);
  assert.equal(hit.kind, "content");
  return hit.contents;
};

describe("generate-service-tests", () => {
  it("emits a mock unit test per generic service and skips custom stubs", async () => {
    const entries = await generate({
      reader: fixtureReader(yaml),
      settings: {},
    });
    const paths = entries.map((e) => e.filename).sort();
    assert.deepEqual(paths, [
      "package.json",
      "roleService.test.ts",
      "skuService.test.ts",
      "userService.test.ts",
    ]);
    const pkg = entries.find((e) => e.filename === "package.json");
    assert.equal(pkg?.kind, "patch");
    if (pkg?.kind === "patch") {
      assert.deepEqual(JSON.parse(pkg.content), {
        devDependencies: { "@faker-js/faker": "^9.9.0" },
      });
    }

    const user = textOf(entries, "userService.test.ts");
    assert.match(user, /import \{ faker \} from "@faker-js\/faker"/);
    assert.match(
      user,
      /from "@deterministic-code\/deterministic\/repositories"/,
    );
    assert.match(user, /import \{ UserService \} from "\.\.\/userService"/);
    assert.match(user, /entityName: "user"/);
    assert.match(user, /new PrimaryKey\("id", "integer"\)/);
    assert.match(user, /faker\.number\.int\(\{ min: 1 \}\)/);
    assert.match(user, /findAll delegates to the repository/);

    const sku = textOf(entries, "skuService.test.ts");
    assert.match(sku, /new PrimaryKey\("code", "string"\)/);
    assert.match(sku, /faker\.string\.alphanumeric/);
  });

  it("emits nothing without view_type_services", async () => {
    const entries = await generate({
      reader: fixtureReader({
        ...yaml,
        "services.yaml": NO_INCLUDES,
      }),
      settings: {},
    });
    assert.deepEqual(entries, []);
  });

  it("points repository imports at bundled _deterministic when requested", async () => {
    const entries = await generate({
      reader: fixtureReader(yaml),
      settings: {
        "languages.typescript.library_reference_mode": "bundled",
      },
    });
    const user = textOf(entries, "userService.test.ts");
    assert.match(user, /from "\.\.\/\.\.\/\.\.\/_deterministic\/repositories\.js"/);
  });
});
