import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import { generate } from "../src/generate-perf-server.ts";

const DS = `types:
  - user:
      tags: [datasource_type]
      inherits: set
      fields:
        - email:
            type: string
`;

describe("generate-perf-server", () => {
  it("rejects a missing types.yaml", async () => {
    await assert.rejects(
      () => generate({ reader: memoryReader({}), settings: {} }),
      /types\.yaml is required/,
    );
  });

  it("emits the server, vitest config, and package.json patch", async () => {
    const entries = await generate({
      reader: memoryReader({ "types.yaml": DS }),
      settings: {},
    });
    const names = entries.map((e) => e.filename);
    assert.ok(names.includes("perf-server.ts"));
    assert.ok(names.includes("vitest.perf.config.ts"));
    assert.ok(names.includes("package.json"));
    assert.equal(names.includes("tsconfig.json"), false);
    const server = entries.find((e) => e.filename === "perf-server.ts");
    assert.equal(server?.kind, "content");
    if (server?.kind === "content") {
      assert.match(
        server.contents,
        /from "@deterministic-code\/deterministic\/app"/,
      );
    }
  });

  it("uses a bundled app import when requested", async () => {
    const entries = await generate({
      reader: memoryReader({ "types.yaml": DS }),
      settings: {
        "languages.typescript.library_reference_mode": "bundled",
      },
    });
    const server = entries.find((e) => e.filename === "perf-server.ts");
    assert.equal(server?.kind, "content");
    if (server?.kind === "content") {
      assert.match(server.contents, /_deterministic\/app\.js/);
    }
  });
});
