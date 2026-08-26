import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import { TYPES_YAML } from "@deterministic-code/generators-common/spec-types";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-view-type-validators-tests.ts";

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
  - contact_group:
      tags: [view_type]
      inherits: set
      fields:
        - name:
            type: string
        - members:
            type: contact[]
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

describe("generate view type validators tests", () => {
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

  it("emits one validator test file per expanded view", async () => {
    const byName = indexEntries(await generateWith({}));
    assert.deepEqual(
      [...byName.keys()].sort(),
      [
        "cardPayment.test.ts",
        "cashPayment.test.ts",
        "package.json",
        "payment.test.ts",
        "role.test.ts",
        "tag.test.ts",
        "user.test.ts",
        "userSummary.test.ts",
      ],
    );
  });

  it("declares Rel bag keys for the schema under test", async () => {
    const entries = await generate({
      reader: fixtureReader(),
      settings: {},
    });
    const card = entries.find(
      (entry) =>
        entry.kind === "content" &&
        entry.attributes?.module ===
          "types/generated/views/validators/cardPayment.test.ts",
    );
    assert.ok(card);
    assert.equal(card.kind, "content");
    assert.equal(
      card.attributes?.imports,
      "types/generated/views/validators/cardPayment.ts",
    );
    assert.equal(card.attributes?.uses, "CardPaymentSchema");
  });

  it("imports the generated schema and covers parse, nullable, and reject cases", async () => {
    const card = await bodyOf(
      "cardPayment.test.ts",
      {},
      SIMPLE_VIEW_YAML,
      undefined,
    );
    assert.match(card, /import \{ CardPaymentSchema \} from "\.\.\/cardPayment";/);
    assert.match(card, /it\("parses a valid payload"/);
    assert.match(card, /it\("accepts null for nullable fields"/);
    assert.match(card, /it\("rejects when missing required field \\"amount\\""/);
    assert.match(
      card,
      /it\("rejects when null for non-nullable field \\"amount\\""/,
    );
    assert.doesNotMatch(
      card,
      /it\("rejects when missing required field \\"note\\""/,
    );
    assert.match(card, /note: null/);
    assert.match(card, /amount: faker\.commerce\.price\(\)/);
    assert.match(card, /paid_at: faker\.date\.recent\(\)/);
  });

  it("requires union-mapped enrichment on nested view members", async () => {
    const group = await bodyOf(
      "contactGroup.test.ts",
      {},
      CONTACT_ENRICH_YAML,
    );
    assert.match(
      group,
      /it\("rejects when missing required field \\"members.contact_source_name\\""/,
    );
  });

  it("covers nested datasource and view fields on a shaped view", async () => {
    const card = await bodyOf("cardPayment.test.ts");
    assert.match(card, /tags: \[\{ /);
    assert.match(card, /label: faker\.string\.alphanumeric\(\{ length: 12 \}\)/);
    assert.match(card, /owner: \{ /);
    assert.match(card, /display_name: faker\.string\.alphanumeric\(\{ length: 12 \}\)/);
    assert.match(
      card,
      /it\("rejects when missing required field \\"owner.display_name\\""/,
    );
    assert.match(
      card,
      /it\("rejects when missing required field \\"tags.label\\""/,
    );
  });

  it("renders an empty shaped view schema test", async () => {
    const payment = await bodyOf("payment.test.ts");
    assert.match(payment, /import \{ PaymentSchema \} from "\.\.\/payment";/);
    assert.doesNotMatch(payment, /it\("accepts a CardPayment member"/);
  });

  it("writes codegen.schema_version into the file header", async () => {
    const card = await bodyOf(
      "cardPayment.test.ts",
      { "codegen.schema_version": "9.9" },
      SIMPLE_VIEW_YAML,
      undefined,
    );
    assert.match(card, /schema-version: 9.9/);
  });
});
