import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCasing } from "../src/common/default-casing.ts";
import { customRelKey } from "../src/emit.ts";

describe("customRelKey", () => {
  it("prefixes ../ emit paths with the cased directory name", () => {
    const pascal = createCasing({
      "languages.typescript.casing.directories": "Pascal",
    });
    assert.equal(
      customRelKey("../custom/foo.ts", pascal.convertDirectories("services")),
      "Services/custom/foo.ts",
    );

    const kebab = createCasing({
      "languages.typescript.casing.directories": "Kebab",
    });
    assert.equal(
      customRelKey("../custom/foo.ts", kebab.convertDirectories("services")),
      "services/custom/foo.ts",
    );
  });
});
