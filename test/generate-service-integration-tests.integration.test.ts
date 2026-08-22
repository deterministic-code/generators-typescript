import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-service-integration-tests.ts";

const VIEW_YAML = `includes:
  - datasource_types:
      include: "*"
types: []
`;

const SERVICES_YAML = `includes:
  - view_type_services:
      filter: 'type is view_type || type is datasource_type'
services: []
`;

const CONTACTS_DS = `types:
  - contact_source:
      datasource_type: "readonly-lookup"
      fields:
        - name:
            type: string
            size: 64
            is_unique: true
  - contact:
      fields:
        - contact_source_id:
            type: number
            references: contact_source.id
        - first_name:
            type: string
        - last_name:
            type: string
  - address:
      fields:
        - contact_id:
            type: number
            references: contact.id
        - line1:
            type: string
        - city:
            type: string
  - contact_group:
      fields:
        - name:
            type: string
            is_unique: true
  - contact_group_member:
      datasource_type: "many-to-many"
      fields:
        - contact_id:
            type: number
            references: contact.id
        - contact_group_id:
            type: number
            references: contact_group.id
  - legacy_contact:
      skip_migrations: true
      fields:
        - key:
            type: string
            primary_key: true
  - contact_change_log:
      target: None
      fields:
        - occurred_at:
            type: datetime
`;

const SEEDS = `seeds:
  - contact_source:
      - id1:
          name: Manual
`;

const EMPTY_SEEDS = `seeds:
  - contact_source: []
`;

const textOf = (entries: GenerateEntry[], path: string): string => {
  const hit = entries.find((e) => e.kind === "content" && e.filename === path);
  assert.ok(
    hit,
    `missing entry ${path}; got ${entries.map((e) => e.filename).join(", ")}`,
  );
  assert.equal(hit.kind, "content");
  return hit.contents;
};

const generateContacts = (seeds: string) =>
  generate({
    reader: memoryReader({
      "datasource_types.yaml": CONTACTS_DS,
      "view_types.yaml": VIEW_YAML,
      "services.yaml": SERVICES_YAML,
      "datasource_seeds.yaml": seeds,
    }),
    settings: {},
  });

describe("generate-service-integration-tests", () => {
  it("uses the physical (pluralized) table name by default", async () => {
    const entries = await generateContacts(SEEDS);
    const body = textOf(
      entries,
      "contactGroupMemberService.integration.test.ts",
    );
    assert.match(body, /const TABLE_NAME = "contact_group_members"/);
    assert.doesNotMatch(body, /const TABLE_NAME = "contact_group_member"/);
  });

  it("keeps the authored table name when pluralize is off", async () => {
    const entries = await generate({
      reader: memoryReader({
        "datasource_types.yaml": CONTACTS_DS,
        "view_types.yaml": VIEW_YAML,
        "services.yaml": SERVICES_YAML,
        "datasource_seeds.yaml": SEEDS,
      }),
      settings: { "datasource.pluralize_datatable_names": "false" },
    });
    const body = textOf(
      entries,
      "contactGroupMemberService.integration.test.ts",
    );
    assert.match(body, /const TABLE_NAME = "contact_group_member"/);
  });

  it("skips skip_migrations and target None tables", async () => {
    const entries = await generateContacts(SEEDS);
    const names = entries
      .filter((e) => e.kind === "content")
      .map((e) => e.filename);
    assert.ok(names.includes("addressService.integration.test.ts"));
    assert.ok(!names.includes("legacyContactService.integration.test.ts"));
    assert.ok(!names.includes("contactChangeLogService.integration.test.ts"));
  });

  it("creates parents, updates the item and parents, then deletes in reverse", async () => {
    const entries = await generateContacts(SEEDS);
    const body = textOf(entries, "addressService.integration.test.ts");
    assert.match(body, /create, update, and delete with parents/);
    assert.match(body, /contactSourceService\.findById\(1\)/);
    assert.match(body, /contactService\.create/);
    assert.match(body, /contact_source_id:/);
    assert.match(body, /service\.create/);
    assert.match(body, /contact_id:/);
    assert.match(body, /service\.update/);
    assert.match(body, /contactService\.update/);
    assert.match(body, /service\.delete/);
    assert.match(body, /service\.findById/);
    assert.match(body, /contactService\.delete/);
    assert.doesNotMatch(body, /as never/);
    assert.match(body, /SqliteStandardRepository<Address>/);
    assert.match(body, /SqliteStandardRepository<Contact>/);
    assert.match(body, /SqliteStandardRepository<ContactSource>/);
    assert.match(body, /import type \{ Address \} from /);
    assert.match(body, /import type \{ UpdateAddress \} from /);
    assert.match(body, /import type \{ Contact \} from /);
    assert.match(body, /import type \{ UpdateContact \} from /);
    assert.match(body, /as UpdateContact/);
    assert.match(body, /as UpdateAddress/);
    assert.match(body, /contact_source\.id/);
    assert.match(body, /contact\.id/);
    assert.doesNotMatch(body, /as \{ /);
    const deleteAt = body.indexOf("service.delete");
    const parentDeleteAt = body.indexOf("contactService.delete");
    assert.ok(deleteAt >= 0 && parentDeleteAt > deleteAt);
  });

  it("creates both m2m parents before the junction row", async () => {
    const entries = await generateContacts(SEEDS);
    const body = textOf(
      entries,
      "contactGroupMemberService.integration.test.ts",
    );
    assert.match(body, /contactService\.create/);
    assert.match(body, /contactGroupService\.create/);
    assert.match(body, /contact_group_id:/);
    const contactCreate = body.indexOf("contactService.create");
    const groupCreate = body.indexOf("contactGroupService.create");
    const memberCreate = body.lastIndexOf("service.create");
    assert.ok(contactCreate < memberCreate && groupCreate < memberCreate);
  });

  it("comments out the hierarchy test when a readonly-lookup has no seeds", async () => {
    const entries = await generateContacts(EMPTY_SEEDS);
    const body = textOf(entries, "addressService.integration.test.ts");
    assert.match(
      body,
      /Seed data does not exist for readonly-lookup "contact_source"/,
    );
    assert.doesNotMatch(body, /create, update, and delete with parents/);
    assert.doesNotMatch(body, /service\.create\(/);
  });
});
