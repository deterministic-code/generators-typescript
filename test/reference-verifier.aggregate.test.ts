import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import { content } from "@deterministic-code/generators-common/generate-entry";
import {
  finalizeEntries,
  referenceAttributesFromEntries,
  ReferenceVerifier,
} from "@deterministic-code/generators-common/reference-verifier";
import { generate as generateDatasourceTypes } from "../src/generate-datasource-types.ts";
import { generate as generateRoutes } from "../src/generate-routes.ts";
import { generate as generateServices } from "../src/generate-services.ts";
import { generate as generateViewTypes } from "../src/generate-view-types.ts";

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
    ...(await generateServices(ctx)),
    ...(await generateRoutes(ctx)),
  ];
};

describe("reference verifier aggregate", () => {
  it("finalizes datasource + view + service + route entries together", async () => {
    const entries = await generateLanes({});
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
