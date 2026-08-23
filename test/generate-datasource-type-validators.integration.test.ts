import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import { TYPES_YAML } from "@deterministic-code/generators-common/spec-types";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-datasource-type-validators.ts";

const FIXTURE_YAML = `types:
  - user:
      tags: [datasource_type]
      inherits: set
      fields:
        - email:
            type: string
            size: 256
            min_size: 3
        - role_id:
            type: number
            references: role.id
        - nick_name:
            type: string
            is_nullable: true
        - active:
            type: boolean
            default_value: false
        - score:
            type: float
            min_size: 0
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

describe("generate datasource type validators", () => {
  const generateWith = (settings: Record<string, string> = {}) =>
    generate({
      reader: fixtureReader(),
      settings,
    });

  const userBody = async (settings: Record<string, string> = {}) => {
    const map = indexEntries(await generateWith(settings));
    const userFile = [...map.keys()].find(
      (name) => name === "user.ts" || name.endsWith("/user.validator.ts"),
    );
    assert.ok(userFile, "missing user validator generate entry");
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

  it("emits one validator per datasource type plus a barrel", async () => {
    const byName = indexEntries(await generateWith({}));
    assert.deepEqual(
      [...byName.keys()].sort(),
      ["index.ts", "role.ts", "user.ts"],
    );
  });

  it("emits a zod object schema with system columns and field constraints", async () => {
    const user = await userBody();
    assert.match(user, /import \{ z \} from "zod";/);
    assert.match(user, /export const UserSchema = z\.object\(/);
    assert.match(user, /export type UserValidated = z\.infer<typeof UserSchema>/);
    assert.match(user, /id: z\.number\(\)\.int\(\)\.nonnegative\(\)/);
    assert.match(user, /email: z\.string\(\)\.trim\(\)\.min\(3\)\.max\(256\)/);
    assert.match(user, /role_id: z\.number\(\)\.int\(\)\.nonnegative\(\)/);
    assert.match(user, /nick_name: z\.string\(\)\.trim\(\)\.nullable\(\)/);
    assert.match(user, /active: z\.boolean\(\)\.default\(false\)/);
    assert.match(user, /score: z\.number\(\)\.min\(0\)/);
  });

  it("drops the uuid column and uses uuid ids when datasource.id_type=uuid", async () => {
    const user = await userBody({ "datasource.id_type": "uuid" });
    assert.match(user, /id: z\.string\(\)\.uuid\(\)/);
    assert.match(user, /role_id: z\.number\(\)\.int\(\)\.nonnegative\(\)/);
  });

  it("skips the barrel when codegen.create_index is false", async () => {
    const byName = indexEntries(
      await generateWith({ "codegen.create_index": "false" }),
    );
    assert.deepEqual([...byName.keys()].sort(), ["role.ts", "user.ts"]);
  });

  it("writes codegen.schema_version into the file header", async () => {
    const user = await userBody({ "codegen.schema_version": "9.9" });
    assert.match(user, /schema-version: 9.9/);
  });

  it("re-exports schemas from the barrel", async () => {
    const index = entryBody(
      requireEntry(indexEntries(await generateWith({})), "index.ts"),
    );
    assert.match(index, /export \{ UserSchema \} from "\.\/user";/);
    assert.match(
      index,
      /export type \{ UserValidated \} from "\.\/user";/,
    );
  });

  it("snakes schema and validated type names", async () => {
    const user = await userBody({
      "languages.typescript.casing.types": "Snake",
    });
    assert.match(user, /export const user_schema = z\.object\(/);
    assert.match(
      user,
      /export type user_validated = z\.infer<typeof user_schema>/,
    );
    assert.doesNotMatch(user, /userSchema/);
    assert.doesNotMatch(user, /UserValidated/);
  });
});
