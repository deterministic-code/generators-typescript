import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import {
  DATASOURCE_TYPES_YAML,
  VIEW_TYPES_YAML,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-view-types-tests.ts";

const DS_YAML = `types:
  - user:
      datasource_type: audit
      fields:
        - email:
            type: string
        - nick_name:
            type: string
            is_nullable: true
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

describe("generate view types tests", () => {
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

  it("rejects a datasource_types include without datasource_types.yaml", async () => {
    await assert.rejects(
      () =>
        generate({
          reader: memoryReader({
            [VIEW_TYPES_YAML]: `includes:
  - datasource_types:
      include: "*"
types: []
`,
          }),
          settings: {},
        }),
      /no datasource_types\.yaml was provided/,
    );
  });

  it("rejects an invalid datasource_types.filter expression", async () => {
    await assert.rejects(
      () =>
        generate({
          reader: memoryReader({
            [VIEW_TYPES_YAML]: `includes:
  - datasource_types:
      include: "*"
      filter: type.datasource_type ===
types: []
`,
            [DATASOURCE_TYPES_YAML]: DS_YAML,
          }),
          settings: {},
        }),
      /datasource_types.filter is not a valid expression/,
    );
  });

  it("emits one accessor test file per expanded view", async () => {
    const byName = indexEntries(await generateWith({}));
    assert.deepEqual(
      [...byName.keys()].sort(),
      [
        "cardPayment.test.ts",
        "cashPayment.test.ts",
        "package.json",
        "payment.test.ts",
        "tag.test.ts",
        "updateTag.test.ts",
        "updateUser.test.ts",
        "updateUserSummary.test.ts",
        "user.test.ts",
        "userSummary.test.ts",
      ],
    );
  });

  it("imports the generated type and covers get/set plus null assignment", async () => {
    const card = await bodyOf(
      "cardPayment.test.ts",
      {},
      SIMPLE_VIEW_YAML,
      undefined,
    );
    assert.match(card, /import type \{ CardPayment \} from "\.\.\/cardPayment";/);
    assert.match(card, /from "vitest"/);
    assert.match(card, /const sample = \(\): CardPayment => \(/);
    for (const field of ["amount", "paid_at", "note"]) {
      assert.match(card, new RegExp(`it\\("gets ${field}"`));
      assert.match(card, new RegExp(`it\\("sets ${field}"`));
    }
    assert.match(card, /it\("allows setting note to null"/);
    assert.doesNotMatch(card, /it\("allows setting amount to null"/);
    assert.match(card, /import \{ faker \} from "@faker-js\/faker"/);
    assert.match(card, /amount: faker\.commerce\.price\(\)/);
    assert.match(card, /paid_at: faker\.date\.recent\(\)/);
    assert.match(card, /note: faker\.string\.alphanumeric\(\{ length: 12 \}\)/);
  });

  it("covers nested datasource and view fields on a shaped view", async () => {
    const card = await bodyOf("cardPayment.test.ts");
    assert.match(card, /it\("gets tags"/);
    assert.match(card, /it\("sets tags"/);
    assert.match(card, /it\("gets tags.label"/);
    assert.match(card, /it\("sets tags.label"/);
    assert.match(card, /it\("gets owner"/);
    assert.match(card, /it\("gets owner.display_name"/);
    assert.match(card, /it\("sets owner.display_name"/);
    assert.match(card, /tags: \[\{ /);
    assert.match(card, /label: faker\.string\.alphanumeric\(\{ length: 12 \}\)/);
    assert.match(card, /owner: \{ /);
    assert.match(card, /display_name: faker\.string\.alphanumeric\(\{ length: 12 \}\)/);
    assert.doesNotMatch(card, /\{\} as tag/);
    assert.doesNotMatch(card, /\{\} as user_summary/);
  });

  it("emits union member accept cases instead of field accessors", async () => {
    const payment = await bodyOf("payment.test.ts");
    assert.match(payment, /import type \{ Payment \} from "\.\.\/payment";/);
    assert.match(
      payment,
      /import type \{ CardPayment \} from "\.\/cardPayment";/,
    );
    assert.match(
      payment,
      /import type \{ CashPayment \} from "\.\/cashPayment";/,
    );
    assert.match(payment, /it\("accepts a CardPayment member"/);
    assert.match(payment, /it\("accepts a CashPayment member"/);
    assert.doesNotMatch(payment, /const sample = /);
    assert.doesNotMatch(payment, /it\("gets /);
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

  it("covers remaining primitive sample literals", async () => {
    const card = await bodyOf(
      "cardPayment.test.ts",
      {},
      `types:
  - card_payment:
      fields:
        - count:
            type: number
        - rank:
            type: integer
        - small_rank:
            type: smallinteger
        - big_rank:
            type: biginteger
        - score:
            type: float
        - active:
            type: boolean
        - token:
            type: uuid
        - avatar:
            type: binary
        - initial:
            type: character
        - ref_id:
            type: reference
        - flags:
            type: boolean[]
`,
      undefined,
    );
    assert.match(card, /count: faker\.number\.int\(\{ min: 1 \}\)/);
    assert.match(card, /rank: faker\.number\.int\(\{ min: 1 \}\)/);
    assert.match(card, /score: faker\.number\.float\(\)/);
    assert.match(card, /active: faker\.datatype\.boolean\(\)/);
    assert.match(card, /token: faker\.string\.uuid\(\)/);
    assert.match(card, /avatar: faker\.string\.alphanumeric\(\{ length: 24 \}\)/);
    assert.match(card, /initial: faker\.string\.alphanumeric\(\{ length: 12 \}\)/);
    assert.match(card, /ref_id: faker\.number\.int\(\{ min: 1 \}\)/);
    assert.match(card, /flags: \[faker\.datatype\.boolean\(\)\]/);
  });

  it("renders empty shaped and union views", async () => {
    const empty = await bodyOf(
      "emptyView.test.ts",
      {},
      `types:
  - empty_view:
      fields: []
  - empty_union:
      one_of: []
`,
      undefined,
    );
    assert.match(empty, /const sample = \(\): EmptyView => \(\{\}\);/);
    assert.doesNotMatch(empty, /it\("gets /);
    const union = await bodyOf(
      "emptyUnion.test.ts",
      {},
      `types:
  - empty_view:
      fields: []
  - empty_union:
      one_of: []
`,
      undefined,
    );
    assert.doesNotMatch(union, /it\("accepts a /);
  });
});
