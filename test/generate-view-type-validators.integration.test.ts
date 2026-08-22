import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import {
  DATASOURCE_TYPES_YAML,
  VIEW_TYPES_YAML,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-view-type-validators.ts";

const DS_YAML = `types:
  - user:
      datasource_type: audit
      fields:
        - email:
            type: string
            size: 256
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
            min_size: 1
            size: 64
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
        "updateTag.ts",
        "updateUser.ts",
        "updateUserSummary.ts",
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

  it("renders a union view", async () => {
    const payment = await bodyOf("payment.ts");
    assert.match(
      payment,
      /import \{ CardPaymentSchema \} from "\.\/cardPayment";/,
    );
    assert.match(
      payment,
      /import \{ CashPaymentSchema \} from "\.\/cashPayment";/,
    );
    assert.match(
      payment,
      /export const PaymentSchema = z\.union\(\[\n  z\.lazy\(\(\) => CardPaymentSchema\),\n  z\.lazy\(\(\) => CashPaymentSchema\),\n\]\);/,
    );
    assert.doesNotMatch(payment, /createPaymentSchema/);
  });

  it("inherits a datasource schema with omit, enrich, and no CRUD trio for omit views", async () => {
    const summary = await bodyOf("userSummary.ts");
    assert.match(
      summary,
      /import \{ UserSchema as DatasourceUserSchema \} from "\.\.\/\.\.\/datasource\/validators\/user";/,
    );
    assert.match(
      summary,
      /export const UserSummarySchema = DatasourceUserSchema\.omit\(\{ "role_id": true, "nick_name": true \}\)\.partial\(\{ id: true \}\)\.extend\(\{\n  display_name: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(64\),\n  role_name: z\.string\(\)\.trim\(\),\n\}\);/,
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
      /export const UserSchema = DatasourceUserSchema\.omit\(\{ "role_id": true \}\)\.extend\(\{\n  role_name: z\.string\(\)\.trim\(\),\n\}\);/,
    );
    assert.doesNotMatch(user, /export const UpdateUserSchema/);
    assert.doesNotMatch(user, /export const CreateUserSchema/);
    assert.doesNotMatch(user, /export const PatchUserSchema/);
  });

  it("omits only parent stamps on parser-derived update views", async () => {
    const updateUser = await bodyOf("updateUser.ts");
    assert.match(
      updateUser,
      /export const UpdateUserSchema = DatasourceUserSchema\.omit\(\{ "role_id": true, "id": true, "uuid": true, "created": true, "updated": true \}\)\.extend\(\{\n  role_name: z\.string\(\)\.trim\(\),\n\}\);/,
    );
    assert.doesNotMatch(updateUser, /export const CreateUserSchema/);
    assert.doesNotMatch(updateUser, /export const PatchUserSchema/);
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
    assert.match(index, /export \{ PaymentSchema \} from "\.\/payment";/);
    assert.match(index, /export \{ UserSchema \} from "\.\/user";/);
    assert.match(index, /export \{ UpdateUserSchema \} from "\.\/updateUser";/);
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

  it("datasource.id_type=uuid drops uuid from inherited update omits", async () => {
    const updateUser = await bodyOf("updateUser.ts", {
      "datasource.id_type": "uuid",
    });
    assert.match(
      updateUser,
      /export const UpdateUserSchema = DatasourceUserSchema\.omit\(\{ "role_id": true, "id": true, "created": true, "updated": true \}\)/,
    );
    assert.doesNotMatch(
      updateUser,
      /UpdateUserSchema = DatasourceUserSchema\.omit\(\{[^}]*"uuid"/,
    );
  });

  it("omits only keys present on a custom-PK parent when OCC is off", async () => {
    const dsYaml = `types:
  - legacy_contact:
      fields:
        - key:
            type: string
            size: 64
            primary_key: true
        - first_name:
            type: string
`;
    const viewYaml = `includes:
  - datasource_types:
      include: "*"
types: []
`;
    const settings = { "datasource.use_optimistic_concurrency": "false" };
    const passThrough = await bodyOf(
      "legacyContact.ts",
      settings,
      viewYaml,
      dsYaml,
    );
    assert.match(
      passThrough,
      /export const LegacyContactSchema = DatasourceLegacyContactSchema;/,
    );
    assert.doesNotMatch(passThrough, /export const UpdateLegacyContactSchema/);
    assert.doesNotMatch(passThrough, /\.omit\(/);

    const update = await bodyOf(
      "updateLegacyContact.ts",
      settings,
      viewYaml,
      dsYaml,
    );
    assert.match(
      update,
      /export const UpdateLegacyContactSchema = DatasourceLegacyContactSchema\.omit\(\{ "key": true \}\);/,
    );
    assert.doesNotMatch(update, /"id": true/);
    assert.doesNotMatch(update, /"created": true/);
    assert.doesNotMatch(update, /"updated": true/);

    const create = await bodyOf(
      "createLegacyContact.ts",
      settings,
      viewYaml,
      dsYaml,
    );
    assert.match(
      create,
      /export const CreateLegacyContactSchema = DatasourceLegacyContactSchema;/,
    );
    assert.doesNotMatch(create, /\.omit\(/);
  });

});
