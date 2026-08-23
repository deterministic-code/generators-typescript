import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  fileReader,
  memoryReader,
} from "@deterministic-code/generators-common/deterministic-reader";
import { TYPES_YAML } from "@deterministic-code/generators-common/spec-types";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-datasource-types.ts";

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
        - created:
            type: datetime
        - updated:
            type: datetime
        - created_at:
            type: datetime
        - nick_name:
            type: string
            is_nullable: true
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

describe("generate", () => {
  const generateWith = (settings: Record<string, string>) =>
    generate({
      reader: fixtureReader(),
      settings,
    });

  const userBody = async (settings: Record<string, string> = {}) => {
    const map = indexEntries(await generateWith(settings));
    const userFile = [...map.keys()].find((name) => name.endsWith("user.ts"));
    assert.ok(userFile, "missing user.ts generate entry");
    return entryBody(requireEntry(map, userFile));
  };

  it("exists reports presence without a prior pathExists probe", async () => {
    const memory = fixtureReader();
    assert.equal(await memory.exists(TYPES_YAML), true);
    assert.equal(await memory.exists("view_types.yaml"), false);
    const dir = await mkdtemp(join(tmpdir(), "generate-datasource-types-"));
    try {
      const files = fileReader(dir);
      assert.equal(await files.exists(TYPES_YAML), false);
      await writeFile(join(dir, TYPES_YAML), FIXTURE_YAML);
      assert.equal(await files.exists(TYPES_YAML), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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

  it("rejects a missing types.yaml from a file reader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "generate-datasource-types-"));
    try {
      await assert.rejects(
        () =>
          generate({
            reader: fileReader(dir),
            settings: {},
          }),
        /missing types\.yaml/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads types.yaml from a file reader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "generate-datasource-types-"));
    try {
      await writeFile(join(dir, TYPES_YAML), FIXTURE_YAML);
      const wrapped = await generate({
        reader: fileReader(dir),
        settings: { "codegen.schema_version": "2.0" },
      });
      const user = entryBody(requireEntry(indexEntries(wrapped), "user.ts"));
      assert.match(user, /schema-version: 2\.0/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("emits one interface file per datasource type", async () => {
    const byName = indexEntries(
      await generate({
        reader: fixtureReader(),
        settings: {
          application_name: "catalog-api",
          "languages.typescript.library_reference_mode": "npm",
        },
      }),
    );
    assert.deepEqual(
      [...byName.keys()].sort(),
      ["index.ts", "role.ts", "user.ts"],
    );
    for (const filename of ["index.ts", "role.ts", "user.ts"]) {
      assert.equal(filename.startsWith("features/"), false, filename);
      assert.equal(requireEntry(byName, filename).kind, "content");
    }
  });

  it("renders user against StandardDataSource and the npm types library", async () => {
    const user = await userBody({
      application_name: "catalog-api",
      "languages.typescript.library_reference_mode": "npm",
    });
    assert.match(user, /schema-version: 1\.0/);
    assert.match(
      user,
      /from "@deterministic-code\/deterministic\/types"/,
    );
    assert.match(
      user,
      /export interface User extends StandardDataSource<number, Date>/,
    );
    assert.match(user, /id: number;/);
    assert.match(user, /uuid: string;/);
    assert.match(user, /created: Date;/);
    assert.match(user, /updated: Date;/);
    assert.match(user, /email: string;/);
    assert.match(user, /role_id: number;/);
    assert.match(user, /created_at: Date;/);
    assert.match(user, /nick_name: string \| null;/);
  });

  it("emits a barrel when codegen.create_index is true", async () => {
    const withIndex = await generateWith({
      "codegen.create_index": "true",
    });
    const map = indexEntries(withIndex);
    const index = entryBody(requireEntry(map, "index.ts"));
    assert.match(index, /export \{ User \} from "\.\/user";/);
    assert.match(index, /export \{ Role \} from "\.\/role";/);
  });

  it("writes codegen.schema_version into the file header", async () => {
    const user = await userBody({ "codegen.schema_version": "9.9" });
    assert.match(user, /schema-version: 9.9/);
  });

  it("comments=simple emits a one-line type doc", async () => {
    const user = await userBody({ comments: "simple" });
    assert.match(user, /\/\*\* Type User\. \*\//);
    assert.doesNotMatch(user, /Datasource type:/);
  });

  it("comments=description emits the multi-line type doc", async () => {
    const user = await userBody({ comments: "description" });
    assert.match(user, /\/\*\*/);
    assert.match(user, /\* Type User\./);
    assert.match(user, /\* Datasource type: standard\./);
    assert.match(user, /\* Target: StandardCrud\./);
    assert.match(user, /\* Fields: 8\./);
  });

  it("comments=none omits the type doc", async () => {
    const user = await userBody({ comments: "none" });
    assert.doesNotMatch(user, /\/\*\*/);
    assert.doesNotMatch(user, /Type User/);
  });

  it("library_reference_mode=bundled imports the vendored types module", async () => {
    const user = await userBody({
      "languages.typescript.library_reference_mode": "bundled",
    });
    assert.match(
      user,
      /from "\.\.\/\.\.\/\.\.\/_deterministic\/types\.js"/,
    );
  });

  it("datasource.id_type=biginteger uses number ids", async () => {
    const user = await userBody({ "datasource.id_type": "biginteger" });
    assert.match(user, /StandardDataSource<number, Date>/);
  });

  it("datasource.id_type=string uses string ids", async () => {
    const user = await userBody({ "datasource.id_type": "string" });
    assert.match(user, /StandardDataSource<string, Date>/);
  });

  it("datasource.id_type=uuid uses a string id", async () => {
    const user = await userBody({ "datasource.id_type": "uuid" });
    assert.match(user, /export interface User extends StandardDataSource<string, Date>/);
    assert.match(user, /role_id: number;/);
  });

  it("unknown datasource.id_type falls back to number ids", async () => {
    const user = await userBody({ "datasource.id_type": "mystery" });
    assert.match(user, /StandardDataSource<number, Date>/);
  });

  it("readonly-lookup extends StandardDataSource with only the id type", async () => {
    const entries = await generate({
      reader: memoryReader({
        [TYPES_YAML]: `types:
  - contact_source:
      tags: [datasource_type, readonly_lookup]
      inherits: set
      fields:
        - name:
            type: string
`,
      }),
      settings: { application_name: "catalog-api" },
    });
    const source = entryBody(
      requireEntry(indexEntries(entries), "contactSource.ts"),
    );
    assert.match(source, /export interface ContactSource extends StandardDataSource<number> \{/);
    assert.doesNotMatch(source, /StandardDataSource<number,\s*>/);
    assert.doesNotMatch(source, /^\s*created:/m);
    assert.doesNotMatch(source, /^\s*updated:/m);
  });

});
