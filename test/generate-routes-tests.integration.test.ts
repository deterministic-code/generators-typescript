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
    assert.match(users, /is defined/);
    assert.doesNotMatch(users, /createCrudRouter/);
    assert.doesNotMatch(users, /PrimaryKey/);
    assert.doesNotMatch(users, /@deterministic-code\/deterministic/);

    const roles = textOf(entries, "role.integration.test.ts");
    assert.match(roles, /import \{ RoleRouter \} from "\.\.\/role"/);
    assert.doesNotMatch(roles, /service.create/);

    const orders = textOf(entries, "order.integration.test.ts");
    assert.doesNotMatch(orders, /If-Match/);
    assert.doesNotMatch(orders, /expectedUpdated/);

    const userBag = entries.find(
      (entry) =>
        entry.kind === "content" &&
        entry.attributes?.module ===
          "routes/generated/__tests__/user.integration.test.ts",
    );
    assert.ok(userBag);
    assert.equal(userBag.kind, "content");
    assert.equal(userBag.attributes?.imports, "routes/generated/user.ts");
    assert.equal(userBag.attributes?.uses, "UserRouter");
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

  it("emits stacked member URLs for a composite identity", async () => {
    const entries = await generate({
      reader: memoryReader({
        "types.yaml": `types:
  - link:
      tags: [datasource_type, view_type]
      inherits: set
      ids: [left_id, right_id]
      fields:
        - left_id:
            type: integer
        - right_id:
            type: integer
`,
        "datasource.yaml": `includes:
  - types:
      filter: tag == "datasource_type"
`,
        "routes.yaml": `includes:
  - types:
      filter: 'type == "link"'
routes: []
`,
      }),
      settings: {},
    });
    const links = textOf(entries, "link.integration.test.ts");
    assert.match(links, /import \{ LinkRouter \} from "\.\.\/link"/);
    assert.doesNotMatch(links, /PrimaryKey/);
  });

  it("kebabs route file imports and API path segments", async () => {
    const entries = await generate({
      reader: memoryReader({
        "types.yaml": `types:
  - contact_group:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - name:
            type: string
`,
        "datasource.yaml": `includes:
  - types:
      filter: tag == "datasource_type"
`,
        "routes.yaml": `includes:
  - types:
      filter: 'type == "contact_group"'
routes: []
`,
      }),
      settings: { "languages.typescript.casing.file_names": "Kebab" },
    });
    const body = textOf(entries, "contact-group.integration.test.ts");
    assert.match(body, /from "\.\.\/contact-group"/);
    assert.doesNotMatch(body, /from "\.\.\/contact_group"/);
  });

  it("imports the route module via ImportGenerator under by-feature", async () => {
    const entries = await generate({
      reader: memoryReader({
        "types.yaml": `types:
  - contact_group:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - name:
            type: string
`,
        "datasource.yaml": `includes:
  - types:
      filter: tag == "datasource_type"
`,
        "routes.yaml": `includes:
  - types:
      filter: 'type == "contact_group"'
routes: []
`,
      }),
      settings: {
        "other.organize_by_feature": "true",
        "languages.typescript.casing.file_names": "Pascal",
      },
    });
    const body = textOf(
      entries,
      "features/contactGroup/__tests__/ContactGroup.integration.test.ts",
    );
    assert.match(body, /from "\.\.\/ContactGroup\.route"/);
    assert.doesNotMatch(body, /from "\.\.\/ContactGroup"/);
  });
});
