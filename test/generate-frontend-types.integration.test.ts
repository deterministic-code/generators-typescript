import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import {
  DATASOURCE_TYPES_YAML,
  VIEW_TYPES_YAML,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate as generateFrontendTypes } from "../src/generate-frontend-types.ts";
import { generate as generateFrontendTypesTests } from "../src/generate-frontend-types-tests.ts";
import { generate as generateFrontendValidators } from "../src/generate-frontend-validators.ts";
import { generate as generateFrontendValidatorsTests } from "../src/generate-frontend-validators-tests.ts";
import { generate as generateViewTypes } from "../src/generate-view-types.ts";
import { generate as generateViewTypesTests } from "../src/generate-view-types-tests.ts";
import { generate as generateViewTypeValidators } from "../src/generate-view-type-validators.ts";
import { generate as generateViewTypeValidatorsTests } from "../src/generate-view-type-validators-tests.ts";

const DS_YAML = `types:
  - tag:
      fields:
        - label:
            type: string
  - user:
      fields:
        - email:
            type: string
        - role_id:
            type: number
            references: role.id
  - role:
      datasource_type: readonly-lookup
      fields:
        - name:
            type: string
            is_unique: true
`;

const VIEW_YAML = `includes:
  - datasource_types:
      include: "*"
      auto_enrich: true
types:
  - card_payment:
      fields:
        - amount:
            type: decimal
        - paid_at:
            type: datetime
        - tags:
            type: datasource_types.tag[]
        - owner:
            type: user
        - note:
            type: string
            is_nullable: true
  - payment:
      one_of:
        - card_payment
        - cash_payment
  - cash_payment:
      fields:
        - amount:
            type: decimal
`;

const ctx = {
  reader: memoryReader({
    [VIEW_TYPES_YAML]: VIEW_YAML,
    [DATASOURCE_TYPES_YAML]: DS_YAML,
  }),
  settings: {},
};

const entryBody = (entry: GenerateEntry): string =>
  "contents" in entry ? String(entry.contents) : entry.content;

const fileBase = (filename: string): string =>
  filename.slice(filename.lastIndexOf("/") + 1);

const withoutImports = (body: string): string =>
  body
    .split("\n")
    .filter((line) => !line.startsWith("import "))
    .join("\n");

const byBase = (entries: GenerateEntry[]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== "content") continue;
    map.set(fileBase(entry.filename), entryBody(entry));
  }
  return map;
};

const assertSharedBodies = (
  frontend: GenerateEntry[],
  backend: GenerateEntry[],
) => {
  const contentOf = (entries: GenerateEntry[]) =>
    entries.filter((e) => e.kind === "content");
  assert.deepEqual(
    contentOf(frontend).map((e) => fileBase(e.filename)).sort(),
    contentOf(backend).map((e) => fileBase(e.filename)).sort(),
  );
  const front = byBase(frontend);
  const back = byBase(backend);
  for (const [name, body] of back) {
    assert.equal(withoutImports(front.get(name) ?? ""), withoutImports(body), name);
  }
};

const referenced = {
  ...ctx,
  settings: { reference_backend_type: "true" },
};

describe("generate-frontend-types", () => {
  it("rejects a missing view_types.yaml", async () => {
    await assert.rejects(
      () => generateFrontendTypes({ reader: memoryReader({}), settings: {} }),
      /missing view_types\.yaml/,
    );
  });

  it("emits a standalone type by default", async () => {
    const frontend = await generateFrontendTypes(ctx);
    const files = byBase(frontend);
    const user = files.get("user.ts") ?? "";
    const card = files.get("cardPayment.ts") ?? "";
    assert.doesNotMatch(user, /extends /);
    assert.match(user, /email: string;/);
    assert.match(user, /role_name: string;/);
    assert.match(card, /from "\.\/tag"/);
    assert.doesNotMatch(card, /types\/generated\/datasource/);
    assert.equal(
      frontend.some((e) => e.filename === "frontend/src/types/index.ts"),
      true,
    );
  });

  it("inlines nothing when datasource_types.yaml is absent", async () => {
    const frontend = await generateFrontendTypes({
      reader: memoryReader({
        [VIEW_TYPES_YAML]: `types:
  - cash_payment:
      fields:
        - amount:
            type: decimal
`,
      }),
      settings: {},
    });
    const cash = byBase(frontend).get("cashPayment.ts") ?? "";
    assert.match(cash, /export interface CashPayment/);
    assert.match(cash, /amount: string;/);
    assert.doesNotMatch(cash, /extends /);
  });

  it("shares view-type bodies when reference_backend_type is true", async () => {
    const frontend = await generateFrontendTypes(referenced);
    assertSharedBodies(frontend, await generateViewTypes(ctx));
    const card = byBase(frontend).get("cardPayment.ts") ?? "";
    assert.match(
      card,
      /from "\.\.\/\.\.\/\.\.\/types\/generated\/datasource\/tag"/,
    );
    assert.match(card, /from "\.\/user"/);
  });
});

describe("generate-frontend-types-tests", () => {
  it("shares view-type-test bodies and colocates the type import", async () => {
    const frontend = await generateFrontendTypesTests(ctx);
    assertSharedBodies(frontend, await generateViewTypesTests(ctx));
    const card = byBase(frontend).get("cardPayment.test.ts") ?? "";
    assert.match(card, /from "\.\/cardPayment"/);
    assert.doesNotMatch(card, /from "\.\.\/cardPayment"/);
    assert.equal(
      frontend[0]?.filename.startsWith("frontend/src/types/"),
      true,
    );
  });
});

describe("generate-frontend-validators", () => {
  it("emits a standalone schema by default", async () => {
    const frontend = await generateFrontendValidators(ctx);
    const files = byBase(frontend);
    const user = files.get("user.ts") ?? "";
    const card = files.get("cardPayment.ts") ?? "";
    assert.match(user, /export const UserSchema = z\.object\(/);
    assert.match(user, /email:/);
    assert.doesNotMatch(user, /datasource_UserSchema/);
    assert.match(card, /from "\.\/tag"/);
    assert.doesNotMatch(card, /types\/generated\/datasource/);
    assert.equal(
      frontend.some((e) => e.filename === "frontend/src/validators/index.ts"),
      true,
    );
  });

  it("shares view-validator bodies when reference_backend_type is true", async () => {
    const frontend = await generateFrontendValidators(referenced);
    assertSharedBodies(frontend, await generateViewTypeValidators(ctx));
    const card = byBase(frontend).get("cardPayment.ts") ?? "";
    assert.match(
      card,
      /from "\.\.\/\.\.\/\.\.\/types\/generated\/datasource\/validators\/tag"/,
    );
    assert.match(card, /from "\.\/user"/);
  });
});

describe("generate-frontend-validators-tests", () => {
  it("shares view-validator-test bodies and colocates the schema import", async () => {
    const frontend = await generateFrontendValidatorsTests(ctx);
    assertSharedBodies(frontend, await generateViewTypeValidatorsTests(ctx));
    const card = byBase(frontend).get("cardPayment.test.ts") ?? "";
    assert.match(card, /from "\.\/cardPayment"/);
    assert.equal(
      frontend[0]?.filename.startsWith("frontend/src/validators/"),
      true,
    );
  });

  it("nests enrichment fields on included datasource views", async () => {
    const frontend = await generateFrontendValidatorsTests({
      reader: memoryReader({
        [DATASOURCE_TYPES_YAML]: `types:
  - status:
      datasource_type: readonly-lookup
      fields:
        - name:
            type: string
            is_unique: true
  - project:
      fields:
        - name:
            type: string
            is_unique: true
  - task:
      fields:
        - title:
            type: string
        - project_id:
            type: number
            references: project.id
        - status_id:
            type: number
            references: status.id
`,
        [VIEW_TYPES_YAML]: `includes:
  - datasource_types:
      include: "*"
      auto_enrich: true
types:
  - project:
      inherits: datasource_types.project
      fields:
        - tasks:
            type: datasource_types.task[]
            references: datasource_types.task.project_id
`,
      }),
      settings: {},
    });
    const project = byBase(frontend).get("project.test.ts") ?? "";
    assert.match(project, /project_name:/);
    assert.match(project, /status_name:/);
  });
});
