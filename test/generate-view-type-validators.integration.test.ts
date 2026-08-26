import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import { TYPES_YAML } from "@deterministic-code/generators-common/spec-types";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-view-type-validators.ts";

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

describe("generate view type validators", () => {
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

  it("emits one validator per expanded view and a barrel by default", async () => {
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

  it("renders a shaped view with primitive, datasource, and view fields plus CRUD trio", async () => {
    const card = await bodyOf("cardPayment.ts");
    assert.match(card, /schema-version: 1\.0/);
    assert.match(card, /import \{ z \} from "zod";/);
    assert.match(
      card,
      /import \{ TagSchema as DatasourceTagSchema \} from "\.\.\/\.\.\/datasource\/validators\/tag";/,
    );
    assert.match(
      card,
      /import \{ UserSummarySchema \} from "\.\/userSummary";/,
    );
    assert.match(card, /export const CardPaymentSchema = z\.object\(\{/);
    assert.match(card, /amount: z\.string\(\),/);
    assert.match(card, /paid_at: z\.date\(\),/);
    assert.match(card, /tags: z\.array\(z\.lazy\(\(\) => DatasourceTagSchema\)\),/);
    assert.match(card, /owner: z\.lazy\(\(\) => UserSummarySchema\),/);
    assert.match(card, /note: z\.string\(\)\.trim\(\)\.nullable\(\),/);
    assert.match(card, /export const CreateCardPaymentSchema = CardPaymentSchema;/);
    assert.match(card, /export const UpdateCardPaymentSchema = CardPaymentSchema;/);
    assert.match(
      card,
      /export const PatchCardPaymentSchema = CardPaymentSchema\.partial\(\);/,
    );
    assert.match(
      card,
      /export type CardPaymentValidated = z\.infer<typeof CardPaymentSchema>;/,
    );
  });

  it("renders an empty shaped view", async () => {
    const payment = await bodyOf("payment.ts");
    assert.match(payment, /export const PaymentSchema = z\.object\(\{\}\);/);
  });

  it("declares Rel bag keys and the inherited parent schema", async () => {
    const entries = await generateWith({});
    const summary = entries.find(
      (entry) =>
        entry.kind === "content" &&
        entry.attributes?.module ===
          "types/generated/views/validators/userSummary.ts",
    );
    assert.ok(summary);
    assert.equal(summary.kind, "content");
    assert.match(summary.attributes?.exports ?? "", /UserSummarySchema/);
    assert.match(
      summary.attributes?.imports ?? "",
      /types\/generated\/datasource\/validators\/user\.ts/,
    );
    assert.match(summary.attributes?.uses ?? "", /UserSchema/);
  });

  it("extends a datasource schema with union-mapped enrichment columns", async () => {
    const contact = await bodyOf("contact.ts", {}, CONTACT_ENRICH_YAML);
    assert.match(
      contact,
      /export const ContactSchema = DatasourceContactsBaseSchema\.extend\(\{\n  contact_source_name: z\.string\(\)\.trim\(\),\n  phones: z\.array\(z\.lazy\(\(\) => PhoneSchema\)\),\n\}\);/,
    );
    const group = await bodyOf("contactGroup.ts", {}, CONTACT_ENRICH_YAML);
    assert.match(group, /members: z\.array\(z\.lazy\(\(\) => ContactSchema\)\)/);
  });

  it("inherits a datasource schema with omit, enrich, and no CRUD trio for omit views", async () => {
    const summary = await bodyOf("userSummary.ts");
    assert.match(
      summary,
      /import \{ UserSchema as DatasourceUserSchema \} from "\.\.\/\.\.\/datasource\/validators\/user";/,
    );
    assert.match(
      summary,
      /export const UserSummarySchema = DatasourceUserSchema\.omit\(\{ "nick_name": true, "role_id": true \}\)\.partial\(\{ id: true \}\)\.extend\(\{\n  display_name: z\.string\(\)\.trim\(\),\n\}\);/,
    );
    assert.doesNotMatch(summary, /create_UserSummarySchema/);
    assert.doesNotMatch(summary, /update_UserSummarySchema/);
  });

  it("emits only the read schema for inherited pass-through views", async () => {
    const user = await bodyOf("user.ts");
    assert.match(
      user,
      /import \{ UserSchema as DatasourceUserSchema \} from "\.\.\/\.\.\/datasource\/validators\/user";/,
    );
    assert.match(
      user,
      /export const UserSchema = DatasourceUserSchema;/,
    );
    assert.doesNotMatch(user, /export const UpdateUserSchema/);
    assert.doesNotMatch(user, /export const CreateUserSchema/);
    assert.doesNotMatch(user, /export const PatchUserSchema/);
  });

  it("does not omit missing audit columns on readonly-lookup views", async () => {
    const role = await bodyOf("role.ts");
    assert.match(role, /export const RoleSchema = DatasourceRoleSchema;/);
    assert.doesNotMatch(role, /\.omit\(/);
    assert.doesNotMatch(role, /created/);
    assert.doesNotMatch(role, /updated/);
    assert.doesNotMatch(role, /export const UpdateRoleSchema/);
    assert.doesNotMatch(role, /export const CreateRoleSchema/);
  });

  it("skips the barrel when codegen.create_index is false", async () => {
    const emitted = await generateWith({ "codegen.create_index": "false" });
    assert.equal(
      emitted.some((e) => e.filename === "index.ts"),
      false,
    );
  });

  it("writes the barrel with schemas and skips omit-only views", async () => {
    const index = await bodyOf("index.ts");
    assert.match(
      index,
      /export \{ CardPaymentSchema, CreateCardPaymentSchema, UpdateCardPaymentSchema, PatchCardPaymentSchema \} from "\.\/cardPayment";/,
    );
    assert.match(
      index,
      /export \{ PaymentSchema, CreatePaymentSchema, UpdatePaymentSchema, PatchPaymentSchema \} from "\.\/payment";/,
    );
    assert.match(index, /export \{ UserSchema \} from "\.\/user";/);
    assert.match(index, /export \{ RoleSchema \} from "\.\/role";/);
    assert.match(
      index,
      /export type \{ CardPaymentValidated \} from "\.\/cardPayment";/,
    );
    assert.doesNotMatch(index, /export \{ UserSummarySchema \}/);
    assert.doesNotMatch(index, /from "\.\/userSummary"/);
  });

  it("writes codegen.schema_version into the file header", async () => {
    const card = await bodyOf("cardPayment.ts", {
      "codegen.schema_version": "9.9",
    });
    assert.match(card, /schema-version: 9.9/);
  });

  it("aliases a dual-tagged view onto its datasource schema", async () => {
    const body = await bodyOf(
      "legacyContact.ts",
      {},
      `types:
  - legacy_contact:
      tags: [datasource_type, view_type]
      fields:
        - key:
            type: string
        - first_name:
            type: string
`,
    );
    assert.match(
      body,
      /export const LegacyContactSchema = DatasourceLegacyContactSchema;/,
    );
    assert.doesNotMatch(body, /\.omit\(/);
  });

});
