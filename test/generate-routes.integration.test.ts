import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-routes.ts";

const TYPES = `types:
  - user:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
            size: 256
        - role_id:
            type: number
            references: role.id
        - active:
            type: boolean
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
  - order_item:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - order_id:
            type: number
            references: order.id
        - sku:
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
combined_routes:
  - order:
      combines:
        - order_item
`;

const textOf = (entries: GenerateEntry[], path: string): string => {
  const hit = entries.find((e) => e.kind === "content" && e.filename === path);
  assert.ok(hit, `missing entry ${path}; got ${entries.map((e) => e.filename).join(", ")}`);
  assert.equal(hit.kind, "content");
  return hit.contents;
};

describe("generate-routes", () => {
  it("emits CRUD, readonly, byField, and custom health", async () => {
    const entries = await generate({
      reader: memoryReader({
        "types.yaml": TYPES,
        "datasource.yaml": DATASOURCE,
        "routes.yaml": ROUTES_YAML,
      }),
      settings: {},
    });

    const paths = entries.map((e) => e.filename).sort();
    assert.ok(paths.includes("user.ts"), `got: ${paths.join(", ")}`);
    assert.ok(paths.includes("role.ts"));
    assert.ok(paths.includes("order.ts"));
    assert.ok(paths.includes("index.ts"));
    assert.ok(paths.includes("../custom/index.ts"));
    assert.equal(paths.includes("tsconfig.json"), false);
    assert.ok(paths.some((p) => p.includes("getHealth")));
    assert.ok(
      !paths.some((p) => p.includes("nested")),
      `nested routers must not emit; got ${paths.join(", ")}`,
    );

    const users = textOf(entries, "user.ts");
    assert.match(users, /export function UserRouter/);
    assert.match(users, /IUserService/);
    assert.match(users, /createCrudRouter/);
    assert.match(users, /router\.get\("\/email\/:email"/);

    const roles = textOf(entries, "role.ts");
    assert.match(roles, /createReadOnlyRouter/);

    const index = textOf(entries, "index.ts");
    assert.match(index, /export \{ UserRouter \} from "\.\/user"/);
    assert.match(index, /export \{ RoleRouter \} from "\.\/role"/);
  });

  it("emits OCC option when enabled", async () => {
    const entries = await generate({
      reader: memoryReader({
        "types.yaml": TYPES,
        "datasource.yaml": DATASOURCE,
        "routes.yaml": `includes:
  - types:
      filter: 'type == "order"'
routes: []
`,
      }),
      settings: { "datasource.use_optimistic_concurrency": "true" },
    });
    const orders = textOf(entries, "order.ts");
    assert.match(orders, /useOptimisticConcurrency: true/);
  });

  it("omits index when codegen.create_index is false", async () => {
    const entries = await generate({
      reader: memoryReader({
        "types.yaml": TYPES,
        "datasource.yaml": DATASOURCE,
        "routes.yaml": `includes:
  - types:
      filter: 'type == "user"'
routes: []
`,
      }),
      settings: { "codegen.create_index": "false" },
    });
    const paths = entries.map((e) => e.filename);
    assert.ok(paths.includes("user.ts"));
    assert.ok(!paths.includes("index.ts"));
  });

  it("rejects missing routes.yaml", async () => {
    await assert.rejects(
      () =>
        generate({
          reader: memoryReader({
            "types.yaml": TYPES,
            "datasource.yaml": DATASOURCE,
          }),
          settings: {},
        }),
      /routes\.yaml/,
    );
  });
});
