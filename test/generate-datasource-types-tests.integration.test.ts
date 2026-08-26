import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import { TYPES_YAML } from "@deterministic-code/generators-common/spec-types";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-datasource-types-tests.ts";

const FIXTURE_YAML = `types:
  - user:
      tags: [datasource_type]
      inherits: set
      fields:
        - email:
            type: string
            size: 256
        - role_id:
            type: number
            references: role.id
        - uuid:
            type: uuid
        - created_at:
            type: datetime
        - nick_name:
            type: string
            is_nullable: true
        - active:
            type: boolean
        - balance:
            type: decimal
        - avatar:
            type: binary
  - role:
      tags: [datasource_type]
      inherits: set
      fields:
        - name:
            type: string
`;

const fixtureReader = () =>
  memoryReader({ [TYPES_YAML]: FIXTURE_YAML });

const entryBody = (entry: GenerateEntry): string => {
  if ("contents" in entry) return String(entry.contents);
  return entry.content;
};

const indexEntries = (entries: GenerateEntry[]): Map<string, GenerateEntry> => {
  const map = new Map<string, GenerateEntry>();
  for (const entry of entries) {
    assert.equal(
      map.has(entry.filename),
      false,
      `duplicate generate entry: ${entry.filename}`,
    );
    map.set(entry.filename, entry);
  }
  return map;
};

const requireEntry = (
  map: Map<string, GenerateEntry>,
  filename: string,
): GenerateEntry => {
  const entry = map.get(filename);
  if (entry === undefined) {
    throw new Error(`missing generate entry: ${filename}`);
  }
  return entry;
};

describe("generate datasource types tests", () => {
  const generateWith = (settings: Record<string, string> = {}) =>
    generate({
      reader: fixtureReader(),
      settings,
    });

  const userBody = async (settings: Record<string, string> = {}) => {
    const map = indexEntries(await generateWith(settings));
    const userFile = [...map.keys()].find((name) =>
      name.endsWith("user.test.ts"),
    );
    assert.ok(userFile, "missing user.test.ts generate entry");
    return entryBody(requireEntry(map, userFile));
  };

  it("rejects a missing types.yaml", async () => {
    await assert.rejects(
      () =>
        generate({
          reader: memoryReader({}),
          settings: {},
        }),
      /missing types\.yaml/,
    );
  });

  it("emits one test file per datasource type", async () => {
    const byName = indexEntries(await generateWith({}));
    assert.deepEqual(
      [...byName.keys()].sort(),
      ["package.json", "role.test.ts", "user.test.ts"],
    );
    const pkg = requireEntry(byName, "package.json");
    assert.equal(pkg.kind, "patch");
    assert.deepEqual(JSON.parse(entryBody(pkg)), {
      devDependencies: { "@faker-js/faker": "^9.9.0" },
    });
  });

  it("declares Rel bag keys for the type under test", async () => {
    const entries = await generateWith({});
    const user = entries.find(
      (entry) =>
        entry.kind === "content" &&
        entry.attributes?.module ===
          "types/generated/datasource/user.test.ts",
    );
    assert.ok(user);
    assert.equal(user.kind, "content");
    assert.equal(
      user.attributes?.imports,
      "types/generated/datasource/user.ts",
    );
    assert.equal(user.attributes?.uses, "User");
  });

  it("imports the generated type from the sibling module", async () => {
    const user = await userBody();
    assert.match(user, /import type \{ User \} from "\.\.\/user";/);
    assert.match(user, /from "vitest"/);
    assert.match(user, /const sample = \(\): User => \(/);
  });

  it("covers getters and setters for system columns and declared fields", async () => {
    const user = await userBody();
    const fields = [
      "id",
      "uuid",
      "email",
      "role_id",
      "created_at",
      "nick_name",
      "active",
      "balance",
      "avatar",
    ];
    for (const field of fields) {
      assert.match(user, new RegExp(`it\\("gets ${field}"`));
      assert.match(user, new RegExp(`it\\("sets ${field}"`));
    }
    assert.match(user, /it\("allows setting nick_name to null"/);
    assert.doesNotMatch(user, /it\("allows setting email to null"/);
    assert.match(user, /import \{ faker \} from "@faker-js\/faker"/);
    assert.match(user, /email: faker\.string\.alphanumeric\(\{ length: 256 \}\)/);
    assert.match(user, /active: faker\.datatype\.boolean\(\)/);
    assert.match(user, /balance: faker\.commerce\.price\(\)/);
  });

  it("writes codegen.schema_version into the file header", async () => {
    const user = await userBody({ "codegen.schema_version": "9.9" });
    assert.match(user, /schema-version: 9.9/);
  });

});
