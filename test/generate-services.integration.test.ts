import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-services.ts";

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
  - role:
      tags: [datasource_type, view_type, readonly_lookup]
      inherits: set
      fields:
        - name:
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
`;

const SERVICES_YAML = `includes:
  - types:
      filter: 'tag == "view_type"'
services:
  - name: ReportService
`;

const ROUTES_YAML = `routes:
  - getReport:
      method: GET
      path: /api/report
      service: ReportService
      function: run
  - health:
      method: GET
      path: /api/health
      service: HealthCheckService
      function: check
`;

const fixtureReader = (files: Record<string, string>) => memoryReader(files);

const textOf = (entries: GenerateEntry[], path: string): string => {
  const hit = entries.find((e) => e.kind === "content" && e.filename === path);
  assert.ok(hit, `missing entry ${path}`);
  assert.equal(hit.kind, "content");
  return hit.contents;
};

describe("generate-services", () => {
  it("emits generic services, finders, custom stubs, and indexes", async () => {
    const entries = await generate({
      reader: fixtureReader({
        "types.yaml": TYPES,
        "datasource.yaml": DATASOURCE,
        "services.yaml": SERVICES_YAML,
        "routes.yaml": ROUTES_YAML,
      }),
      settings: {},
    });

    const paths = entries.map((e) =>
      e.kind === "content" ? e.filename : e.filename,
    ).sort();
    assert.ok(paths.includes("userService.ts"), `got: ${paths.join(", ")}`);
    assert.ok(paths.includes("roleService.ts"));
    assert.ok(paths.includes("../custom/reportService.ts"));
    assert.ok(
      paths.some((p) => /health/i.test(p)),
      `health stub missing; got: ${paths.join(", ")}`,
    );
    assert.ok(paths.includes("index.ts"));
    assert.ok(paths.includes("../custom/index.ts"));
    assert.equal(
      entries.some((e) => e.filename === "tsconfig.json"),
      false,
    );
    assert.equal(
      entries.some((e) => e.kind === "patch" && e.filename === "app.ts"),
      false,
    );

    const user = textOf(entries, "userService.ts");
    assert.match(
      user,
      /export class UserService extends BaseService<User>/,
    );
    assert.match(user, /async find_by_email\(email: string\)/);
    assert.match(
      user,
      /from "\.\.\/\.\.\/types\/generated\/datasource\/user"/,
    );
    const role = textOf(entries, "roleService.ts");
    assert.match(role, /export class RoleService extends BaseService<Role>/);
    assert.doesNotMatch(role, /UpdateRole/);

    const report = textOf(entries, "../custom/reportService.ts");
    assert.match(report, /async run\(\.\.\._args: unknown\[\]\)/);
    assert.match(report, /return \{\};/);
    const reportEntry = entries.find(
      (e) => e.kind === "content" && e.filename === "../custom/reportService.ts",
    );
    assert.ok(reportEntry);
    assert.equal(reportEntry.kind, "content");
    assert.equal(
      reportEntry.attributes?.module,
      "services/custom/reportService.ts",
    );

    const index = textOf(entries, "index.ts");
    assert.match(index, /export \{ RoleService \} from "\.\/roleService"/);
    assert.match(index, /export \{ UserService \} from "\.\/userService"/);
    assert.match(index, /export type \{ IUserService \} from "\.\/userService"/);
  });

  it("omits indexes when codegen.create_index is false", async () => {
    const entries = await generate({
      reader: fixtureReader({
        "types.yaml": TYPES,
        "datasource.yaml": DATASOURCE,
        "services.yaml": SERVICES_YAML,
        "routes.yaml": ROUTES_YAML,
      }),
      settings: { "codegen.create_index": "false" },
    });
    const paths = entries.map((e) => e.filename);
    assert.ok(paths.includes("userService.ts"));
    assert.ok(!paths.includes("index.ts"));
    assert.ok(!paths.includes("../custom/index.ts"));
  });

  it("emits description doc comments when comments=description", async () => {
    const entries = await generate({
      reader: fixtureReader({
        "types.yaml": TYPES,
        "datasource.yaml": DATASOURCE,
        "services.yaml": `includes:
  - types:
      filter: 'type == "user"'
services: []
`,
      }),
      settings: { comments: "description" },
    });
    const user = textOf(entries, "userService.ts");
    assert.match(user, /Datasource type: standard/);
    assert.match(user, /Target: StandardCrud/);
  });

  it("emits no doc comments when comments=none", async () => {
    const entries = await generate({
      reader: fixtureReader({
        "types.yaml": TYPES,
        "datasource.yaml": DATASOURCE,
        "services.yaml": `includes:
  - types:
      filter: 'type == "user"'
services: []
`,
      }),
      settings: { comments: "none" },
    });
    const user = textOf(entries, "userService.ts");
    assert.ok(!user.includes("/**"));
  });

  it("patches app.ts customModulePaths when by-feature relocates a custom module", async () => {
    const entries = await generate({
      reader: fixtureReader({
        "types.yaml": TYPES,
        "datasource.yaml": DATASOURCE,
        "services.yaml": `includes:
  - types:
      filter: 'tag == "view_type"'
services:
  - name: ContactImportService
    module: ./services/contact-import-service
`,
        "routes.yaml": ROUTES_YAML,
      }),
      settings: { "other.organize_by_feature": "true" },
    });
    const remap = entries.find(
      (e) =>
        e.kind === "patch" &&
        e.filename === "app.ts" &&
        e.section === "APP_CUSTOM_MODULE_PATHS",
    );
    assert.ok(remap, "missing APP_CUSTOM_MODULE_PATHS patch");
    assert.equal(remap.kind, "patch");
    assert.match(remap.content, /customModulePaths:/);
    assert.match(
      remap.content,
      /"\.\/services\/contact-import-service"/,
    );
    assert.match(remap.content, /features\//);
    assert.equal(
      entries.some((e) => e.kind === "patch" && e.filename === "tsconfig.json"),
      false,
    );
  });
});
