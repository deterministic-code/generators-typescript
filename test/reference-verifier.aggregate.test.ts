import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import { content } from "@deterministic-code/generators-common/generate-entry";
import {
  finalizeEntries,
  isRelativeModulePath,
  referenceAttributesFromEntries,
  ReferenceVerifier,
  verifyEntries,
} from "@deterministic-code/generators-common/reference-verifier";
import { generate as generateDatasourceTypeValidators } from "../src/generate-datasource-type-validators.ts";
import { generate as generateDatasourceTypeValidatorsTests } from "../src/generate-datasource-type-validators-tests.ts";
import { generate as generateDatasourceTypes } from "../src/generate-datasource-types.ts";
import { generate as generateDatasourceTypesTests } from "../src/generate-datasource-types-tests.ts";
import { generate as generateRoutes } from "../src/generate-routes.ts";
import { generate as generateRoutesTests } from "../src/generate-routes-tests.ts";
import { generate as generateServiceTests } from "../src/generate-service-tests.ts";
import { generate as generateServices } from "../src/generate-services.ts";
import { generate as generateViewTypeValidators } from "../src/generate-view-type-validators.ts";
import { generate as generateViewTypeValidatorsTests } from "../src/generate-view-type-validators-tests.ts";
import { generate as generateViewTypes } from "../src/generate-view-types.ts";
import { generate as generateViewTypesTests } from "../src/generate-view-types-tests.ts";

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
`;

const SERVICES_YAML = `includes:
  - types:
      filter: 'tag == "view_type"'
services:
  - name: ReportService
  - name: ContactImportService
    module: ./services/contact-import-service
`;

const ROUTES_YAML = `includes:
  - types:
      filter: 'tag == "view_type" || tag == "datasource_type"'
routes:
  - getReport:
      method: GET
      path: /api/report
      service: ReportService
      function: run
`;

const CONTACTS_TYPES = `types:
  - base:
      fields:
        - id:
            type: integer
  - contact_source:
      tags: [datasource_type]
      inherits: base
      fields:
        - name:
            type: string
`;

const VIEW_INHERITS_BASE = `types:
  - base:
      tags: [datasource_type]
      fields:
        - id:
            type: integer
  - child:
      tags: [view_type]
      inherits: base
      fields:
        - name:
            type: string
`;

const fixture = {
  "types.yaml": DS_YAML,
  "services.yaml": SERVICES_YAML,
  "routes.yaml": ROUTES_YAML,
};

const generateLanes = async (settings: Record<string, string>) => {
  const reader = memoryReader(fixture);
  const ctx = { reader, settings };
  return [
    ...(await generateDatasourceTypes(ctx)),
    ...(await generateViewTypes(ctx)),
    ...(await generateDatasourceTypeValidators(ctx)),
    ...(await generateViewTypeValidators(ctx)),
    ...(await generateDatasourceTypesTests(ctx)),
    ...(await generateViewTypesTests(ctx)),
    ...(await generateDatasourceTypeValidatorsTests(ctx)),
    ...(await generateViewTypeValidatorsTests(ctx)),
    ...(await generateServices(ctx)),
    ...(await generateServiceTests(ctx)),
    ...(await generateRoutes(ctx)),
    ...(await generateRoutesTests(ctx)),
  ];
};

const contentEntries = (entries: Awaited<ReturnType<typeof generateLanes>>) =>
  entries.filter((entry) => entry.kind === "content");

describe("reference verifier aggregate", () => {
  it("flattens contact_source when it inherits an untagged base", async () => {
    const entries = await generateDatasourceTypes({
      reader: memoryReader({ "types.yaml": CONTACTS_TYPES }),
      settings: {},
    });
    const modules = contentEntries(entries).map(
      (entry) => entry.attributes?.module,
    );
    assert.equal(
      modules.includes("types/generated/datasource/base.ts"),
      false,
    );
    const source = entries.find(
      (entry) =>
        entry.kind === "content" &&
        entry.attributes?.module ===
          "types/generated/datasource/contactSource.ts",
    );
    assert.ok(source);
    assert.equal(source.kind, "content");
    assert.doesNotMatch(
      source.attributes?.imports ?? "",
      /types\/generated\/datasource\/base\.ts/,
    );
    assert.doesNotThrow(() => verifyEntries(entries));
  });

  it("fails view types when a view inherits a parent this lane does not emit", async () => {
    const entries = await generateViewTypes({
      reader: memoryReader({ "types.yaml": VIEW_INHERITS_BASE }),
      settings: {},
    });
    const child = entries.find(
      (entry) =>
        entry.kind === "content" &&
        entry.attributes?.module === "types/generated/views/child.ts",
    );
    assert.ok(child);
    assert.equal(child.kind, "content");
    assert.match(
      child.attributes?.imports ?? "",
      /types\/generated\/datasource\/base\.ts/,
    );
    assert.throws(
      () => verifyEntries(entries),
      /types\/generated\/datasource\/base\.ts/,
    );
  });

  it("finalizes datasource + view + validator + test + service + route entries together", async () => {
    const entries = await generateLanes({});
    const attributed = contentEntries(entries).filter(
      (entry) => entry.attributes !== undefined,
    );
    assert.ok(attributed.length > 0);
    for (const entry of attributed) {
      const module = entry.attributes?.module;
      assert.ok(module, entry.filename);
      assert.equal(isRelativeModulePath(module), false, module);
      for (const imp of (entry.attributes?.imports ?? "").split(",")) {
        const trimmed = imp.trim();
        if (trimmed.length === 0) continue;
        assert.equal(isRelativeModulePath(trimmed), false, trimmed);
      }
    }
    const custom = attributed.find(
      (entry) =>
        entry.attributes?.module ===
        "services/contact-import-service.ts",
    );
    assert.ok(custom, "custom service Rel should remap ../contact-import-service.ts");
    const finalized = finalizeEntries(entries);
    assert.ok(finalized.length > 0);
    for (const entry of finalized) {
      if (entry.kind === "content") {
        assert.equal(
          "attributes" in entry && entry.attributes !== undefined,
          false,
        );
      }
    }
  });

  it("finalizes snake types so routes use i_user_service, not IuserService", async () => {
    const entries = await generateLanes({
      "languages.typescript.casing.types": "Snake",
    });
    const route = entries.find(
      (entry) =>
        entry.kind === "content" &&
        entry.attributes?.module === "routes/generated/user.ts",
    );
    assert.ok(route);
    assert.equal(route.kind, "content");
    assert.match(route.contents, /i_user_service/);
    assert.doesNotMatch(route.contents, /IuserService/);
    assert.doesNotThrow(() => finalizeEntries(entries));
  });

  it("fails when a route file glues I onto a snake service name", async () => {
    const entries = await generateLanes({
      "languages.typescript.casing.types": "Snake",
    });
    const route = entries.find(
      (entry) =>
        entry.kind === "content" &&
        entry.attributes?.module === "routes/generated/user.ts",
    );
    assert.ok(route);
    assert.equal(route.kind, "content");
    const glued = {
      ...route,
      contents: route.contents.replaceAll("i_user_service", "IuserService"),
    };
    assert.throws(
      () =>
        new ReferenceVerifier().verifyContents(
          entries.map((entry) => (entry === route ? glued : entry)),
        ),
      /missingUse "i_user_service"/,
    );
  });

  it("fails when a service uses a mistyped export name", async () => {
    const reader = memoryReader(fixture);
    const settings = {};
    const entries = [
      ...(await generateDatasourceTypes({ reader, settings })),
      ...(await generateViewTypes({ reader, settings })),
      content("brokenService.ts", "", {
        module: "services/generated/brokenService.ts",
        imports: "types/generated/views/user.ts",
        uses: "user",
      }),
    ];
    assert.throws(
      () =>
        new ReferenceVerifier().verify(referenceAttributesFromEntries(entries)),
      /uses "user"/,
    );
  });
});
