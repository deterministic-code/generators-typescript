import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-service-integration-tests.ts";

const SERVICES_YAML = `includes:
  - types:
      filter: 'tag == "datasource_type"'
services: []
`;

const CONTACTS_DS = `types:
  - contact_source:
      tags: [datasource_type, view_type, readonly_lookup]
      inherits: set
      fields:
        - name:
            type: string
            size: 64
  - contact:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - contact_source_id:
            type: number
            references: contact_source.id
        - first_name:
            type: string
        - last_name:
            type: string
  - address:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - contact_id:
            type: number
            references: contact.id
        - line1:
            type: string
        - city:
            type: string
  - contact_group:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - name:
            type: string
  - contact_group_member:
      tags: [datasource_type, view_type, many_to_many]
      fields:
        - contact_id:
            type: number
            references: contact.id
        - contact_group_id:
            type: number
            references: contact_group.id
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
      "types.yaml": CONTACTS_DS,
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
        "types.yaml": CONTACTS_DS,
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

  it("emits integration tests for persisted tables", async () => {
    const entries = await generateContacts(SEEDS);
    const names = entries
      .filter((e) => e.kind === "content")
      .map((e) => e.filename);
    assert.ok(names.includes("addressService.integration.test.ts"));
    assert.ok(names.includes("contactGroupMemberService.integration.test.ts"));
    const address = entries.find(
      (entry) =>
        entry.kind === "content" &&
        entry.attributes?.module ===
          "services/generated/__tests__/addressService.integration.test.ts",
    );
    assert.ok(address);
    assert.equal(address.kind, "content");
    assert.equal(
      address.attributes?.imports,
      "services/generated/addressService.ts",
    );
    assert.equal(address.attributes?.uses, "AddressService");
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
    assert.match(body, /import type \{ Contact \} from /);
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
