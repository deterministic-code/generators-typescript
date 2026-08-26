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

  it("renders user as a standalone interface with expanded set fields", async () => {
    const user = await userBody({
      application_name: "catalog-api",
    });
    assert.match(user, /schema-version: 1\.0/);
    assert.doesNotMatch(user, /StandardDataSource/);
    assert.doesNotMatch(user, /@deterministic-code\/deterministic/);
    assert.match(user, /export interface User \{/);
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
    assert.match(index, /export type \{ User \} from "\.\/user";/);
    assert.match(index, /export type \{ Role \} from "\.\/role";/);
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
    assert.match(user, /\* Target: ShapedType\./);
    assert.match(user, /\* Fields: 8\./);
  });

  it("comments=none omits the type doc", async () => {
    const user = await userBody({ comments: "none" });
    assert.doesNotMatch(user, /\/\*\*/);
    assert.doesNotMatch(user, /Type User/);
  });

  it("readonly-lookup inlines the injected set id", async () => {
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
    assert.match(source, /export interface ContactSource \{/);
    assert.doesNotMatch(source, /StandardDataSource/);
    assert.match(source, /id: number;/);
    assert.match(source, /name: string;/);
    assert.doesNotMatch(source, /^\s*created:/m);
    assert.doesNotMatch(source, /^\s*updated:/m);
  });

  it("extends an inherited datasource type and lists only local fields", async () => {
    const entries = await generate({
      reader: memoryReader({
        [TYPES_YAML]: `types:
  - user:
      tags: [datasource_type]
      inherits: set
      fields:
        - email:
            type: string
  - admin:
      tags: [datasource_type]
      inherits: user
      remove_fields: [email]
      fields:
        - level:
            type: integer
`,
      }),
      settings: {},
    });
    const byName = indexEntries(entries);
    const user = entryBody(requireEntry(byName, "user.ts"));
    assert.match(user, /export interface User \{/);
    assert.match(user, /id: number;/);
    assert.match(user, /email: string;/);
    const admin = entryBody(requireEntry(byName, "admin.ts"));
    assert.match(admin, /import type \{ User \} from "\.\/user";/);
    assert.match(
      admin,
      /export interface Admin extends Omit<User, "email"> \{/,
    );
    assert.match(admin, /level: number;/);
    assert.doesNotMatch(admin, /^\s*id:/m);
    assert.doesNotMatch(admin, /^\s*email:/m);
    const adminEntry = requireEntry(byName, "admin.ts");
    assert.equal(adminEntry.kind, "content");
    assert.equal(
      adminEntry.attributes?.module,
      "types/generated/datasource/admin.ts",
    );
    assert.equal(adminEntry.attributes?.exports, "Admin");
    assert.equal(
      adminEntry.attributes?.imports,
      "types/generated/datasource/user.ts",
    );
    assert.equal(adminEntry.attributes?.uses, "User");
  });

  it("flattens an untagged inherit source instead of extending it", async () => {
    const entries = await generate({
      reader: memoryReader({
        [TYPES_YAML]: `types:
  - base:
      fields:
        - id:
            type: integer
            is_id: true
        - created:
            type: datetime
  - contact_source:
      tags: [datasource_type]
      inherits: base
      fields:
        - name:
            type: string
`,
      }),
      settings: {},
    });
    const byName = indexEntries(entries);
    assert.equal(byName.has("base.ts"), false);
    const source = entryBody(requireEntry(byName, "contactSource.ts"));
    assert.match(source, /export interface ContactSource \{/);
    assert.doesNotMatch(source, /extends /);
    assert.doesNotMatch(source, /from "\.\/base"/);
    assert.match(source, /id: number;/);
    assert.match(source, /created: Date;/);
    assert.match(source, /name: string;/);
  });

  it("renders a composed union datasource type", async () => {
    const entries = await generate({
      reader: memoryReader({
        [TYPES_YAML]: `types:
  - card:
      tags: [datasource_type]
      fields:
        - amount:
            type: decimal
  - cash:
      tags: [datasource_type]
      fields:
        - tendered:
            type: decimal
  - payment:
      tags: [datasource_type]
      union: [card, cash]
`,
      }),
      settings: {},
    });
    const payment = entryBody(
      requireEntry(indexEntries(entries), "payment.ts"),
    );
    assert.match(payment, /export interface Payment \{/);
    assert.match(payment, /amount: string;/);
    assert.match(payment, /tendered: string;/);
    assert.doesNotMatch(payment, /StandardDataSource/);
  });

  it("omits view collection fields from the datasource row", async () => {
    const entries = await generate({
      reader: memoryReader({
        [TYPES_YAML]: `types:
  - contact:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
        - addresses:
            type: address[]
            references: address.contact_id
  - address:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - contact_id:
            type: number
            references: contact.id
        - city:
            type: string
`,
      }),
      settings: {},
    });
    const contact = entryBody(requireEntry(indexEntries(entries), "contact.ts"));
    assert.match(contact, /email: string;/);
    assert.doesNotMatch(contact, /addresses/);
    const address = entryBody(requireEntry(indexEntries(entries), "address.ts"));
    assert.match(address, /contact_id: number;/);
    assert.match(address, /city: string;/);
  });

});
