import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-client-bindings.ts";
import { generate as generateLiveTests } from "../src/generate-client-bindings-live-tests.ts";
import { generate as generateMockTests } from "../src/generate-client-bindings-mock-tests.ts";
import { projectClientBindings } from "../src/client-bindings-ir.ts";
import { httpPathFromRoutesApi } from "../src/common/http-path.ts";

const TYPES = `types:
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
  - project:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - name:
            type: string
        - tasks:
            type: task[]
            references: task.project_id
  - task:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - title:
            type: string
        - project_id:
            type: number
            references: project.id
  - card_payment:
      tags: [datasource_type, view_type]
      fields:
        - amount:
            type: decimal
`;

const ROUTES_YAML = `includes:
  - types:
      filter: 'tag == "view_type" || tag == "datasource_type"'
      eager_path:
        - project.tasks
      eager_write_path:
        - project.tasks
routes:
  - users_by_email:
  - ping:
      method: POST
      path: /api/ping
      request: missing_shape
      response: missing_shape
combined_routes:
  - project:
      combines:
        - task
`;

const yaml = {
  "types.yaml": TYPES,
  "routes.yaml": ROUTES_YAML,
};

const ctx = {
  reader: memoryReader(yaml),
  settings: {},
};

const textOf = (entries: GenerateEntry[], path: string): string => {
  const hit = entries.find((e) => e.kind === "content" && e.filename === path);
  assert.ok(
    hit,
    `missing entry ${path}; got ${entries.map((e) => e.filename).join(", ")}`,
  );
  assert.equal(hit.kind, "content");
  return hit.contents;
};

describe("httpPathFromRoutesApi", () => {
  it("kebabs static segments and camels path params", () => {
    assert.equal(
      httpPathFromRoutesApi("/api/card_payments/{role_id}"),
      "/api/card-payments/{roleId}",
    );
  });
});

describe("projectClientBindings", () => {
  it("skips unnamed, null, and incomplete route entries", () => {
    const ir = projectClientBindings({
      version: "1.0.0",
      routes: [
        {},
        { ping: null },
        { broken: { method: "GET" } },
        { also: { path: "/api/also" } },
        {
          ping: { path: "/api/ping", method: "POST", entity: null, isCustom: true },
        },
        {
          flush: { path: "/api/flush", method: "POST", entity: null, isCustom: true },
        },
        {
          task: {
            path: "/api/tasks",
            method: "GET",
            entity: "task",
            isCustom: false,
            response: { name: "task", schema: null, example: null },
          },
        },
        {
          nestedGet: {
            path: "/api/projects/{id}/tasks/{id}",
            method: "GET",
            entity: "task",
            isCustom: false,
            response: { name: "task", schema: null, example: null },
          },
        },
      ],
      components: {},
    },
    (typeName) => `../../types/${typeName}`,
    );
    assert.deepEqual(
      ir.entities.map((e) => e.fileBase),
      ["custom", "task"],
    );
    const nested = ir.entities
      .find((e) => e.fileBase === "task")
      ?.methods.find((m) => m.methodName === "nestedGet");
    assert.equal(nested?.args, "id: string | number, id_2: string | number");
    assert.match(nested?.pathExpr ?? "", /id_2/);
    const ping = ir.entities
      .find((e) => e.fileBase === "custom")
      ?.methods.find((m) => m.methodName === "ping");
    assert.equal(ping?.isQuery, false);
    assert.equal(ping?.hasBody, false);
    assert.equal(ping?.returnType, "void");
    const flush = ir.entities
      .find((e) => e.fileBase === "custom")
      ?.methods.find((m) => m.methodName === "flush");
    assert.equal(flush?.hasMutationArg, false);
    const taskList = ir.entities
      .find((e) => e.fileBase === "task")
      ?.methods.find((m) => m.methodName === "task");
    assert.equal(taskList?.isList, true);
    assert.equal(taskList?.returnType, "task[]");
  });
});

describe("generate-client-bindings", () => {
  it("emits fetch, axios, and tanstack modules for CRUD, eager, nested, and custom routes", async () => {
    const entries = await generate(ctx);
    const paths = entries.map((e) => e.filename).sort();
    assert.ok(paths.includes("frontend/src/client/fetch/http.ts"));
    assert.ok(paths.includes("frontend/src/client/axios/http.ts"));
    assert.ok(paths.includes("frontend/src/client/fetch/user.ts"));
    assert.ok(paths.includes("frontend/src/client/axios/user.ts"));
    assert.ok(paths.includes("frontend/src/client/tanstack/user.ts"));
    assert.ok(paths.includes("frontend/src/client/fetch/index.ts"));
    assert.ok(paths.includes("frontend/src/client/index.ts"));

    const fetchUser = textOf(entries, "frontend/src/client/fetch/user.ts");
    assert.match(fetchUser, /export const UserClient/);
    assert.match(fetchUser, /list: \(\) =>/);
    assert.match(fetchUser, /getByEmail: \(email: string \| number\)/);
    assert.match(fetchUser, /method: "POST"/);
    assert.match(fetchUser, /from "\.\.\/\.\.\/types\/user"/);

    const fetchRole = textOf(entries, "frontend/src/client/fetch/role.ts");
    assert.match(fetchRole, /list: \(\) =>/);
    assert.doesNotMatch(fetchRole, /create:/);

    const fetchProject = textOf(entries, "frontend/src/client/fetch/project.ts");
    assert.match(fetchProject, /project_eager_create_body/);
    assert.match(fetchProject, /project_eager_body/);
    assert.match(fetchProject, /project_eager_patch_body/);
    assert.match(fetchProject, /from "\.\.\/\.\.\/types\/project_eager_create_body"/);

    const fetchTask = textOf(entries, "frontend/src/client/fetch/task.ts");
    assert.match(fetchTask, /projectTasksList/);
    assert.match(fetchTask, /id: string \| number/);
    assert.match(
      fetchTask,
      /\/api\/projects\/\$\{encodeURIComponent\(String\(id\)\)\}\/tasks/,
    );

    const fetchCard = textOf(entries, "frontend/src/client/fetch/cardPayment.ts");
    assert.match(fetchCard, /"\/api\/card-payments"/);

    const custom = textOf(entries, "frontend/src/client/fetch/custom.ts");
    assert.match(custom, /ping: \(body: missing_shape\)/);

    const axiosUser = textOf(entries, "frontend/src/client/axios/user.ts");
    assert.equal(axiosUser, fetchUser);

    const tanstackProject = textOf(
      entries,
      "frontend/src/client/tanstack/project.ts",
    );
    assert.match(tanstackProject, /from "@tanstack\/react-query"/);
    assert.match(tanstackProject, /from "\.\.\/fetch\/project\.ts"/);
    assert.match(tanstackProject, /UseProjectList/);
    assert.match(tanstackProject, /UseProjectCreate/);
    assert.match(tanstackProject, /vars\.body/);

    const root = textOf(entries, "frontend/src/client/index.ts");
    assert.match(root, /fetchBindings/);
    assert.match(root, /axiosBindings/);
    assert.match(root, /tanstackBindings/);
  });

  it("emits index files when codegen.create_index is true", async () => {
    const entries = await generate({
      ...ctx,
      settings: { "codegen.create_index": "true" },
    });
    assert.ok(
      entries.some((e) => e.filename === "frontend/src/client/index.ts"),
    );
  });

  it("omits index files when codegen.create_index is false", async () => {
    const entries = await generate({
      ...ctx,
      settings: { "codegen.create_index": "false" },
    });
    assert.equal(
      entries.some((e) => e.filename.endsWith("/index.ts")),
      false,
    );
    assert.ok(
      entries.some((e) => e.filename === "frontend/src/client/fetch/http.ts"),
    );
  });

  it("accepts id: schema references to this backend", async () => {
    const entries = await generate({
      ...ctx,
      settings: { "client_bindings.schema": "id:kitchen-sink" },
    });
    assert.ok(
      entries.some((e) => e.filename === "frontend/src/client/fetch/user.ts"),
    );
  });

  it("rejects a remote schema location", async () => {
    await assert.rejects(
      () =>
        generate({
          ...ctx,
          settings: { "client_bindings.schema": "https://api.example.com/openapi.json" },
        }),
      /not this backend/,
    );
  });

  it("rejects a file schema location", async () => {
    await assert.rejects(
      () =>
        generate({
          ...ctx,
          settings: { "client_bindings.schema": "file:./openapi.json" },
        }),
      /not this backend/,
    );
  });
});

describe("generate-client-bindings-mock-tests", () => {
  it("emits fetch, axios, and tanstack mock tests per entity", async () => {
    const entries = await generateMockTests(ctx);
    const paths = entries.map((e) => e.filename).sort();
    assert.ok(paths.includes("frontend/src/client/fetch/user.mock.test.ts"));
    assert.ok(paths.includes("frontend/src/client/axios/role.mock.test.ts"));
    assert.ok(paths.includes("frontend/src/client/tanstack/project.mock.test.ts"));
    const user = textOf(entries, "frontend/src/client/fetch/user.mock.test.ts");
    assert.match(user, /from "vitest"/);
    assert.match(user, /UserClient mock/);
    assert.match(user, /getByEmail/);
    const tanstack = textOf(
      entries,
      "frontend/src/client/tanstack/custom.mock.test.ts",
    );
    assert.match(tanstack, /from "vitest"/);
    assert.match(tanstack, /async <T>\(\) => \(\{\} as T\)/);
    assert.match(tanstack, /mutationFn delegates/);
    const nested = textOf(
      entries,
      "frontend/src/client/tanstack/task.mock.test.ts",
    );
    assert.match(nested, /id: 1, id_2: 1/);
  });
});

describe("generate-client-bindings-live-tests", () => {
  it("emits fetch, axios, and tanstack live tests against CLIENT_BINDINGS_BASE_URL", async () => {
    const entries = await generateLiveTests(ctx);
    const fetchUser = textOf(
      entries,
      "frontend/src/client/fetch/user.live.test.ts",
    );
    assert.match(fetchUser, /from "vitest"/);
    assert.match(fetchUser, /CLIENT_BINDINGS_BASE_URL/);
    assert.match(fetchUser, /describe\.skipIf/);
    assert.match(fetchUser, /hits the server/);
    assert.doesNotMatch(fetchUser, /catch\(\(\) => undefined\)/);
    const axiosUser = textOf(
      entries,
      "frontend/src/client/axios/user.live.test.ts",
    );
    assert.match(axiosUser, /from "\.\/http\.ts"/);
    const tanstack = textOf(
      entries,
      "frontend/src/client/tanstack/project.live.test.ts",
    );
    assert.match(tanstack, /from "\.\.\/fetch\/http\.ts"/);
    assert.match(tanstack, /queryFn/);
    assert.doesNotMatch(tanstack, /catch\(\(\) => undefined\)/);
  });
});
