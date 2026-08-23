import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-routes-tests.ts";

const DS_YAML = `types:
  - user:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
        - role_id:
            type: number
            references: role.id
  - role:
      tags: [datasource_type, view_type, readonly_lookup]
      inherits: set
      fields:
        - name:
            type: string
  - order:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - label:
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
  - order:
      use_optimistic_concurrency: true
`;

const ROUTES_YAML = `includes:
  - types:
      filter: 'tag == "view_type" || tag == "datasource_type"'
routes:
  - users_by_email:
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

const yaml = {
  "types.yaml": DS_YAML,
  "datasource.yaml": DATASOURCE,
  "routes.yaml": ROUTES_YAML,
};

describe("generate-routes-tests", () => {
  it("emits CRUD, readonly, and by-field router tests", async () => {
    const entries = await generate({
      reader: memoryReader(yaml),
      settings: {},
    });
    const paths = entries.map((e) => e.filename).sort();
    assert.deepEqual(paths, [
      "order.integration.test.ts",
      "package.json",
      "role.integration.test.ts",
      "user.integration.test.ts",
    ]);

    const users = textOf(entries, "user.integration.test.ts");
    assert.match(users, /import \{ UserRouter \} from "\.\.\/user"/);
    assert.match(users, /POST \/api\/user delegates to service.create/);
    assert.match(users, /GET \/api\/user\/email\/:value returns the row/);
    assert.match(users, /new PrimaryKey\("id", "integer"\)/);

    const roles = textOf(entries, "role.integration.test.ts");
    assert.match(roles, /GET \/api\/role returns items from service.findAll/);
    assert.ok(!roles.includes("service.create"));

    const orders = textOf(entries, "order.integration.test.ts");
    assert.match(orders, /If-Match/);
    assert.match(orders, /expectedUpdated: occToken/);
  });

  it("emits nothing without view_type_routes", async () => {
    const entries = await generate({
      reader: memoryReader({
        ...yaml,
        "routes.yaml": "routes: []\n",
      }),
      settings: {},
    });
    assert.deepEqual(entries, []);
  });
});
