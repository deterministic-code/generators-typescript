import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import {
  DATASOURCE_TYPES_YAML,
  VIEW_TYPES_YAML,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-view-type-validators-tests.ts";

const DS_YAML = `types:
  - user:
      datasource_type: audit
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
      datasource_type: readonly-lookup
      fields:
        - name:
            type: string
            is_unique: true
  - tag:
      fields:
        - label:
            type: string
`;

const VIEW_YAML = `includes:
  - datasource_types:
      include: "*"
      auto_enrich: true
types:
  - user_summary:
      inherits: datasource_types.user
      omit:
        - nick_name
      fields:
        - display_name:
            type: string
  - payment:
      one_of:
        - card_payment
        - cash_payment
  - card_payment:
      fields:
        - amount:
            type: decimal
        - paid_at:
            type: datetime
        - tags:
            type: datasource_types.tag[]
        - owner:
            type: user_summary
        - note:
            type: string
            is_nullable: true
  - cash_payment:
      fields:
        - amount:
            type: decimal
`;

const SIMPLE_VIEW_YAML = `types:
  - card_payment:
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
  dsYaml: string | undefined = DS_YAML,
) =>
  memoryReader({
    [VIEW_TYPES_YAML]: viewYaml,
    ...(dsYaml === undefined ? {} : { [DATASOURCE_TYPES_YAML]: dsYaml }),
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

  it("rejects a missing view_types.yaml", async () => {
    await assert.rejects(
      () =>
        generate({
          reader: memoryReader({}),
          settings: {},
        }),
      /missing view_types\.yaml/,
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
        "updateTag.test.ts",
        "updateUser.test.ts",
        "updateUserSummary.test.ts",
        "user.test.ts",
        "userSummary.test.ts",
      ],
    );
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

  it("emits union member accept cases and a neither-member reject", async () => {
    const payment = await bodyOf("payment.test.ts");
    assert.match(payment, /import \{ PaymentSchema \} from "\.\.\/payment";/);
    assert.match(payment, /it\("accepts a CardPayment member"/);
    assert.match(payment, /it\("accepts a CashPayment member"/);
    assert.match(
      payment,
      /it\("rejects when matches neither member of union \\"payment\\""/,
    );
    assert.match(payment, /__not_a_member__: true/);
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
