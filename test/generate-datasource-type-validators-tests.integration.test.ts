import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import {
  DATASOURCE_TYPES_YAML,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-datasource-type-validators-tests.ts";

const FIXTURE_YAML = `types:
  - user:
      datasource_type: audit
      fields:
        - email:
            type: string
            size: 256
        - role_id:
            references: role.id
        - nick_name:
            type: string
            is_nullable: true
        - active:
            type: boolean
            default_value: false
  - role:
      fields:
        - name:
            type: string
`;

const fixtureReader = () =>
  memoryReader({ [DATASOURCE_TYPES_YAML]: FIXTURE_YAML });

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

describe("generate datasource type validators tests", () => {
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

  it("rejects a missing datasource_types.yaml", async () => {
    await assert.rejects(
      () =>
        generate({
          reader: memoryReader({}),
          settings: {},
        }),
      /missing datasource_types\.yaml/,
    );
  });

  it("emits one validator test file per datasource type", async () => {
    const byName = indexEntries(await generateWith({}));
    assert.deepEqual(
      [...byName.keys()].sort(),
      ["package.json", "role.test.ts", "user.test.ts"],
    );
  });

  it("imports the generated schema and covers parse, nullable, and reject cases", async () => {
    const user = await userBody();
    assert.match(user, /import \{ UserSchema \} from "\.\.\/user";/);
    assert.match(user, /from "vitest"/);
    assert.match(user, /it\("parses a valid payload"/);
    assert.match(user, /it\("accepts null for nullable fields"/);
    assert.match(user, /it\("rejects when missing required field \\"email\\""/);
    assert.match(
      user,
      /it\("rejects when null for non-nullable field \\"email\\""/,
    );
    assert.match(user, /it\("rejects when wrong type on field \\"email\\""/);
    assert.match(user, /nick_name: null/);
    assert.match(user, /email: 123/);
    assert.doesNotMatch(
      user,
      /it\("rejects when missing required field \\"active\\""/,
    );
    assert.match(user, /expect\(\(\) => UserSchema\.parse\(value\)\)\.not\.toThrow/);
    assert.match(user, /expect\(\(\) => UserSchema\.parse\(value\)\)\.toThrow/);
  });

  it("writes codegen.schema_version into the file header", async () => {
    const user = await userBody({ "codegen.schema_version": "9.9" });
    assert.match(user, /schema-version: 9.9/);
  });

});
