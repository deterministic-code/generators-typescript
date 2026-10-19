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
import { generate } from "../src/generate-view-types.ts";

const VIEW_YAML = `types:
  - user:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
        - role_id:
            type: number
            references: role.id
        - nick_name:
            type: string
            is_nullable: true
  - role:
      tags: [datasource_type, view_type, readonly_lookup]
      inherits: set
      fields:
        - name:
            type: string
  - tag:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - label:
            type: string
  - user_summary:
      tags: [view_type]
      inherits: user
      remove_fields: [nick_name, role_id]
      fields:
        - display_name:
            type: string
  - payment:
      tags: [view_type]
      fields: []
  - card_payment:
      tags: [view_type]
      fields:
        - amount:
            type: decimal
        - paid_at:
            type: datetime
        - tags:
            type: tag[]
        - owner:
            type: user_summary
        - note:
            type: string
            is_nullable: true
  - cash_payment:
      tags: [view_type]
      fields:
        - amount:
            type: decimal
`;

const CONTACT_ENRICH_YAML = `types:
  - contacts_base:
      tags: [datasource_type]
      inherits: set
      fields:
        - contact_source_id:
            type: integer
            references: contact_source.id
        - first_name:
            type: string
  - contact_source:
      tags: [datasource_type, view_type, readonly_lookup]
      inherits: set
      fields:
        - name:
            type: string
            is_unique: true
  - contact:
      tags: [view_type]
      inherits: contacts_base
      union: [contact_source]
      mapping:
        name: contact_source_name
      remove_fields: [contact_source.id]
      fields:
        - phones:
            type: phone[]
  - phone:
      tags: [view_type]
      fields:
        - number:
            type: string
`;

const SIMPLE_VIEW_YAML = `types:
  - card_payment:
      tags: [view_type]
      fields:
        - amount:
            type: decimal
        - paid_at:
            type: datetime
        - note:
            type: string
            is_nullable: true
`;

const fixtureReader = (
  viewYaml: string = VIEW_YAML,
  dsYaml: string | undefined = undefined,
) =>
  memoryReader({
    [TYPES_YAML]: viewYaml,
  });

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

describe("generate view types", () => {
  const generateWith = (
    settings: Record<string, string> = {},
    viewYaml?: string,
    dsYaml?: string,
  ) =>
    generate({
      reader: fixtureReader(viewYaml, dsYaml),
      settings,
    });

  const bodyOf = async (
    suffix: string,
    settings: Record<string, string> = {},
    viewYaml?: string,
    dsYaml?: string,
  ) => {
    const map = indexEntries(await generateWith(settings, viewYaml, dsYaml));
    const file = [...map.keys()].find((name) => name.endsWith(suffix));
    assert.ok(file, `missing ${suffix} generate entry`);
    return entryBody(requireEntry(map, file));
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

  it("reads types.yaml from a file reader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "generate-view-types-"));
    try {
      await writeFile(join(dir, TYPES_YAML), SIMPLE_VIEW_YAML);
      const wrapped = await generate({
        reader: fileReader(dir),
        settings: { "codegen.schema_version": "2.0" },
      });
      const card = entryBody(
        requireEntry(indexEntries(wrapped), "cardPayment.ts"),
      );
      assert.match(card, /schema-version: 2\.0/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("emits one file per expanded view and a barrel by default", async () => {
    const byName = indexEntries(await generateWith({}));
    assert.deepEqual(
      [...byName.keys()].sort(),
      [
        "cardPayment.ts",
        "cashPayment.ts",
        "index.ts",
        "payment.ts",
        "role.ts",
        "tag.ts",
        "user.ts",
        "userSummary.ts",
      ],
    );
  });

  it("renders a shaped view with primitive, datasource, and view fields", async () => {
    const card = await bodyOf("cardPayment.ts");
    assert.match(card, /schema-version: 1\.0/);
    assert.match(card, /import type \{ Tag \} from "\.\.\/datasource\/tag";/);
    assert.match(
      card,
      /import type \{ UserSummary \} from "\.\/userSummary";/,
    );
    assert.match(card, /\/\*\* View CardPayment\. \*\//);
    assert.match(card, /export interface CardPayment \{/);
    assert.match(card, /amount: string;/);
    assert.match(card, /paid_at: Date;/);
    assert.match(card, /tags: Tag\[\];/);
    assert.match(card, /owner: UserSummary;/);
    assert.match(card, /note: string \| null;/);
  });

  it("renders an empty shaped view", async () => {
    const payment = await bodyOf("payment.ts");
    assert.match(payment, /export interface Payment \{\}/);
  });

  it("declares Rel bag keys and the inherited datasource edge", async () => {
    const entries = await generateWith({});
    const summary = entries.find(
      (entry) =>
        entry.kind === "content" &&
        entry.attributes?.module === "types/generated/views/userSummary.ts",
    );
    assert.ok(summary);
    assert.equal(summary.kind, "content");
    assert.equal(summary.attributes?.exports, "UserSummary");
    assert.match(
      summary.attributes?.imports ?? "",
      /types\/generated\/datasource\/user\.ts/,
    );
    assert.match(summary.attributes?.uses ?? "", /User/);
  });

  it("extends the inherited datasource type and omits enrichment FKs plus explicit omit", async () => {
    const summary = await bodyOf("userSummary.ts");
    assert.match(
      summary,
      /import type \{ User \} from "\.\.\/datasource\/user";/,
    );
    assert.match(
      summary,
      /export interface UserSummary extends Omit<User, "nick_name" \| "role_id"> \{/,
    );
    assert.match(summary, /display_name: string;/);
  });

  it("extends a datasource parent with union-mapped enrichment columns", async () => {
    const contact = await bodyOf("contact.ts", {}, CONTACT_ENRICH_YAML);
    assert.match(
      contact,
      /export interface Contact extends Omit<ContactsBase, "contact_source_id"> \{/,
    );
    assert.match(contact, /contact_source_name: string;/);
    assert.match(contact, /phones: Phone\[\];/);
    assert.doesNotMatch(contact, /first_name:/);
  });

  it("aliases a colliding inherited datasource class name", async () => {
    const user = await bodyOf("user.ts");
    assert.match(
      user,
      /import type \{ User as UserBase \} from "\.\.\/datasource\/user";/,
    );
    assert.match(user, /export interface User extends UserBase \{/);
  });

  it("skips the barrel when codegen.create_index is false", async () => {
    const emitted = await generateWith({ "codegen.create_index": "false" });
    assert.equal(
      emitted.some((e) => e.filename === "index.ts"),
      false,
    );
  });

  it("writes the barrel with type re-exports", async () => {
    const index = await bodyOf("index.ts");
    assert.match(index, /export type \{ User \} from "\.\/user";/);
    assert.match(index, /export type \{ Payment \} from "\.\/payment";/);
    assert.match(
      index,
      /export type \{ UserSummary \} from "\.\/userSummary";/,
    );
  });

  it("writes codegen.schema_version into the file header", async () => {
    const card = await bodyOf("cardPayment.ts", {
      "codegen.schema_version": "9.9",
    });
    assert.match(card, /schema-version: 9.9/);
  });

  it("comments=description emits the multi-line view doc", async () => {
    const card = await bodyOf("cardPayment.ts", { comments: "description" });
    assert.match(card, /\* View CardPayment\./);
    assert.match(card, /\* Datasource type: standard\./);
    assert.match(card, /\* Target: ShapedView\./);
    assert.match(card, /\* Fields: 5\./);
    const payment = await bodyOf("payment.ts", { comments: "description" });
    assert.match(payment, /\* Target: ShapedView\./);
  });

  it("comments=none omits the view doc", async () => {
    const card = await bodyOf("cardPayment.ts", { comments: "none" });
    assert.doesNotMatch(card, /\/\*\*/);
    assert.doesNotMatch(card, /View CardPayment/);
  });

  it("emits a singular nested datasource field without []", async () => {
    const contact = await bodyOf(
      "contact.ts",
      {},
      `types:
  - tag:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - label:
            type: string
  - contact:
      tags: [view_type]
      fields:
        - address:
            type: tag
`,
    );
    assert.match(contact, /import type \{ Tag \} from "\.\.\/datasource\/tag";/);
    assert.match(contact, /address: Tag;/);
    assert.doesNotMatch(contact, /address: Tag\[\];/);
  });

  it("keeps view collection fields on the view type", async () => {
    const contact = await bodyOf(
      "contact.ts",
      {},
      `types:
  - address:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - city:
            type: string
  - contact:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
        - addresses:
            type: address[]
            references: address.contact_id
`,
    );
    assert.match(contact, /import type \{ Address \} from "\.\.\/datasource\/address";/);
    assert.match(contact, /export interface Contact extends ContactBase \{/);
    assert.match(contact, /addresses: Address\[\];/);
  });

  it("emits a class for non-zero defaults and keeps a default-less view as an interface", async () => {
    const yaml = `types:
  - flags:
      tags: [view_type]
      fields:
        - is_enabled:
            type: boolean
            default_value: true
        - is_disabled:
            type: boolean
            default_value: false
        - count:
            type: integer
            default_value: 0
        - rank:
            type: integer
            default_value: 1
        - empty_name:
            type: string
            default_value: ""
        - title:
            type: string
            default_value: hello
        - blob:
            type: binary
            default_value: Hex('00')
        - stamped:
            type: datetime
            default_value: UtcNow
        - opted_out:
            type: boolean
            is_nullable: true
            default_value: false
        - token:
            type: uuid
            default_value: NewId
        - price:
            type: decimal
            default_value: "1.50"
        - local_now:
            type: datetime
            default_value: Now
        - explicit_at:
            type: datetime
            default_value: "DateTime('2026-01-01T00:00:00Z')"
        - empty_id:
            type: uuid
            default_value: Empty
        - fixed_id:
            type: uuid
            default_value: "uuid('11111111-1111-4111-8111-111111111111')"
        - empty_blob:
            type: binary
            default_value: "Hex('')"
        - initial:
            type: character
            default_value: X
        - ratio:
            type: float
            default_value: 1.5
        - visits:
            type: unsignedinteger
            default_value: 1
        - delta:
            type: smallinteger
            default_value: 1
        - port:
            type: unsignedsmallinteger
            default_value: 1
        - big_rank:
            type: biginteger
            default_value: 1
        - huge:
            type: unsignedbiginteger
            default_value: 1
        - amount:
            type: number
            default_value: 1
        - tags:
            type: string[]
            default_value: []
        - extra:
            type: string[]
        - attrs:
            type: labels{}
            references: labels.key
            default_value: {}
        - aliases:
            type: string[]
            is_nullable: true
            default_value: null
  - labels:
      tags: [view_type]
      inherits: dictionary
      fields:
        - key:
            type: string
            size: 64
        - value:
            type: string
            size: 128
  - user:
      tags: [datasource_type]
      inherits: set
      fields:
        - is_enabled:
            type: boolean
            default_value: true
  - user_view:
      tags: [view_type]
      inherits: user
`;
    const flags = await bodyOf("flags.ts", {}, yaml);
    assert.match(flags, /export class Flags \{/);
    assert.match(flags, /is_enabled: boolean = true;/);
    assert.match(flags, /is_disabled!: boolean;/);
    assert.match(flags, /empty_name!: string;/);
    assert.match(flags, /rank: number = 1;/);
    assert.match(flags, /opted_out: boolean \| null = false;/);
    assert.match(flags, /price: string = "1.50";/);
    assert.match(flags, /local_now: Date = new Date\(\);/);
    assert.match(
      flags,
      /explicit_at: Date = new Date\("2026-01-01T00:00:00Z"\);/,
    );
    assert.match(
      flags,
      /empty_id: string = "00000000-0000-0000-0000-000000000000";/,
    );
    assert.match(
      flags,
      /fixed_id: string = "11111111-1111-4111-8111-111111111111";/,
    );
    assert.match(flags, /empty_blob!: string;/);
    assert.doesNotMatch(flags, /empty_blob: string =/);
    assert.match(flags, /initial: string = "X";/);
    assert.match(flags, /ratio: number = 1.5;/);
    assert.match(flags, /visits: number = 1;/);
    assert.match(flags, /amount: number = 1;/);
    assert.match(flags, /tags: string\[\] = \[\];/);
    assert.match(flags, /extra: string\[\] = \[\];/);
    assert.match(flags, /attrs: Dictionary<string, string> = \{\};/);
    assert.match(flags, /aliases: string\[\] \| null;/);
    assert.doesNotMatch(flags, /aliases: string\[\] \| null =/);
    const view = await bodyOf("userView.ts", {}, yaml);
    assert.match(view, /export interface UserView extends User \{/);
    assert.doesNotMatch(view, /export class UserView/);
  });

});
