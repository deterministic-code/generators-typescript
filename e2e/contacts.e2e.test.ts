import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { createCasing } from "../src/common/default-casing.ts";
import { createImportGenerator } from "../src/import-generator.ts";
import {
  bootContactsSample,
  customServicePath,
  datasourceTypePath,
  dumpContactsTrace,
  requireAppFile,
  viewValidatorPath,
  type BootedContactsApp,
} from "./contacts-sample-app.ts";
import {
  asRecord,
  clientFileBase,
  ifMatchHeaders,
  itemsOf,
  loadEntityClient,
  uniqueSuffix,
  type BindingClient,
  type FetchHttp,
} from "./contacts-sample-client.ts";
import {
  CONTACTS_VARIANTS,
  type ContactsVariant,
} from "./contacts-sample-yaml.ts";
import { stopGeneratedApp } from "./generated-app.ts";

const originOf = (port: number): string => `http://127.0.0.1:${port}`;

const asArray = (value: unknown, label: string): unknown[] => {
  assert.ok(Array.isArray(value), `expected ${label} array`);
  return value;
};

const namesOf = (rows: unknown[]): string[] =>
  rows.map((row) => asRecord(row).name).map(String).sort();

const assertNoFk = (row: Record<string, unknown>, fk: string): void => {
  assert.equal(fk in row, false, `expected ${fk} to be omitted`);
};

const entryBody = (entries: GenerateEntry[], filename: string): string => {
  const hit = entries.find(
    (entry) =>
      entry.filename === filename || entry.filename.endsWith(`/${filename}`),
  );
  if (hit === undefined || hit.kind !== "content") {
    throw new Error(`missing generate entry ${filename}`);
  }
  return hit.contents;
};

const SERVICE_ROUTE_ENTITIES = [
  "contact",
  "contact_group",
  "contact_source",
] as const;

const assertServiceInterfacesMatchRoutes = (
  lanes: BootedContactsApp["lanes"],
  settings: Record<string, string>,
): void => {
  const casing = createCasing(settings);
  const imports = createImportGenerator(".", settings);
  for (const entity of SERVICE_ROUTE_ENTITIES) {
    const iface = casing.serviceInterfaceName(entity);
    const route = entryBody(lanes.routes, imports.route(entity));
    const service = entryBody(lanes.services, imports.service(entity));
    assert.match(
      route,
      new RegExp(`import \\{ ${iface} \\}`),
      `${entity} route must import ${iface}`,
    );
    assert.match(
      service,
      new RegExp(`export type ${iface} =`),
      `${entity} service must export ${iface}`,
    );
    assert.doesNotMatch(route, /IcontactService/);
  }
};

const assertSqliteTables = async (
  appDir: string,
  pluralize: boolean,
): Promise<void> => {
  const sql = await readFile(
    join(appDir, "sql/sqlite/migrations/0001_initial_up.sql"),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE "contacts"/);
  if (pluralize) {
    assert.match(sql, /CREATE TABLE "contact_sources"/);
    return;
  }
  assert.match(sql, /CREATE TABLE "contact_source"/);
  assert.doesNotMatch(sql, /CREATE TABLE "contact_sources"/);
};

const assertContactsLayout = async (
  booted: BootedContactsApp,
): Promise<void> => {
  const { appDir, variant, settings, lanes } = booted;
  await Promise.all([
    requireAppFile(appDir, "frontend/src/app.tsx"),
    requireAppFile(appDir, "frontend/src/client/fetch/http.ts"),
    requireAppFile(
      appDir,
      `frontend/src/client/fetch/${clientFileBase("contact", settings)}.ts`,
    ),
    requireAppFile(
      appDir,
      `frontend/src/client/fetch/${clientFileBase("contact_group", settings)}.ts`,
    ),
    requireAppFile(appDir, datasourceTypePath("contacts_base", variant, settings)),
    requireAppFile(
      appDir,
      datasourceTypePath("contact_groups_base", variant, settings),
    ),
    requireAppFile(appDir, viewValidatorPath("contact", variant, settings)),
    requireAppFile(
      appDir,
      viewValidatorPath("contact_source", variant, settings),
    ),
    requireAppFile(
      appDir,
      viewValidatorPath("legacy_contact", variant, settings),
    ),
    requireAppFile(
      appDir,
      customServicePath(
        "ContactImportService",
        "./services/contact-import-service",
        variant,
        settings,
      ),
    ),
    requireAppFile(
      appDir,
      customServicePath(
        "LegacyMigrationService",
        "./services/legacy-migration-service",
        variant,
        settings,
      ),
    ),
  ]);
  const dsFiles = lanes.datasource.map((entry) => entry.filename);
  if (variant.organizeByFeature) {
    assert.ok(dsFiles.some((name) => name.startsWith("features/")));
    assert.ok(
      lanes.services.some((entry) => entry.filename.includes("/custom/")),
    );
  } else {
    assert.equal(
      dsFiles.some((name) => name.startsWith("features/")),
      false,
    );
  }
  await assertSqliteTables(appDir, variant.pluralizeDatatableNames);
  assertServiceInterfacesMatchRoutes(lanes, settings);
};

type GraphClients = {
  http: FetchHttp;
  sources: BindingClient;
  contacts: BindingClient;
  addresses: BindingClient;
  phones: BindingClient;
  groups: BindingClient;
};

const loadGraphClients = async (
  booted: BootedContactsApp,
): Promise<GraphClients> => {
  const baseUrl = originOf(booted.port);
  const { appDir, settings } = booted;
  const [
    { http, client: sources },
    { client: contacts },
    { client: addresses },
    { client: phones },
    { client: groups },
  ] = await Promise.all([
    loadEntityClient(appDir, "contact_source", baseUrl, settings),
    loadEntityClient(appDir, "contact", baseUrl, settings),
    loadEntityClient(appDir, "address", baseUrl, settings),
    loadEntityClient(appDir, "phone", baseUrl, settings),
    loadEntityClient(appDir, "contact_group", baseUrl, settings),
  ]);
  return { http, sources, contacts, addresses, phones, groups };
};

const mutateContact = async (
  clients: GraphClients,
  occ: boolean,
  method: "PATCH" | "PUT",
  id: unknown,
  body: Record<string, unknown>,
  updated: unknown,
): Promise<Record<string, unknown>> => {
  if (!occ) {
    const row =
      method === "PATCH"
        ? await clients.contacts.patch(id, body)
        : await clients.contacts.update(id, body);
    return asRecord(row);
  }
  return asRecord(
    await clients.http.request({
      method,
      path: `/api/contacts/${id}`,
      body,
      headers: ifMatchHeaders(updated),
    }),
  );
};

const assertEnrichment = async (
  clients: GraphClients,
  occ: boolean,
): Promise<string> => {
  const sourceNames = namesOf(itemsOf(await clients.sources.list()));
  assert.deepEqual(sourceNames, ["Imported", "Manual", "OAuth"]);
  assert.equal(typeof clients.sources.create, "undefined");

  const suffix = uniqueSuffix();
  const created = asRecord(
    await clients.contacts.create({
      first_name: "Ada",
      last_name: `Lovelace-${suffix}`,
      contact_source_name: "Manual",
    }),
  );
  assert.equal(created.contact_source_name, "Manual");
  assertNoFk(created, "contact_source_id");
  const id = created.id;
  assert.ok(id !== undefined);

  const got = asRecord(await clients.contacts.get(id));
  assert.equal(got.contact_source_name, "Manual");
  assertNoFk(got, "contact_source_id");

  const listed = itemsOf(await clients.contacts.list()).map(asRecord);
  const listedRow = listed.find((row) => row.id === id);
  assert.ok(listedRow);
  assert.equal(listedRow.contact_source_name, "Manual");
  assertNoFk(listedRow, "contact_source_id");

  const patched = await mutateContact(
    clients,
    occ,
    "PATCH",
    id,
    { contact_source_name: "Imported" },
    created.updated,
  );
  assert.equal(patched.contact_source_name, "Imported");

  await assert.rejects(
    () =>
      mutateContact(
        clients,
        occ,
        "PATCH",
        id,
        { contact_source_name: "NoSuchSource" },
        patched.updated,
      ),
    /failed: 4\d\d/,
  );
  return String(id);
};

const assertEagerWriteAndRead = async (
  clients: GraphClients,
  occ: boolean,
): Promise<{ contactId: unknown; groupId: unknown }> => {
  const suffix = uniqueSuffix();
  const created = asRecord(
    await clients.contacts.create({
      first_name: "Nested",
      last_name: `Contact-${suffix}`,
      contact_source_name: "Manual",
      addresses: [
        { line1: "1 Main St", city: "London" },
        { line1: "2 High St", city: "Oxford" },
      ],
      phones: [
        { number: "111-1111", label: "work" },
        { number: "222-2222", label: "home" },
      ],
    }),
  );
  const contactId = created.id;
  const createdAddresses = asArray(created.addresses, "create.addresses");
  const createdPhones = asArray(created.phones, "create.phones");
  assert.equal(createdAddresses.length, 2);
  assert.equal(createdPhones.length, 2);
  assert.equal("contact_name" in asRecord(createdAddresses[0]!), false);
  assert.equal("contact_name" in asRecord(createdPhones[0]!), false);

  const got = asRecord(await clients.contacts.get(contactId));
  assert.equal(asArray(got.addresses, "get.addresses").length, 2);
  assert.equal(asArray(got.phones, "get.phones").length, 2);
  assert.equal("contact_name" in asRecord(asArray(got.addresses, "get.addresses")[0]!), false);

  const listed = itemsOf(await clients.contacts.list())
    .map(asRecord)
    .find((row) => row.id === contactId);
  assert.ok(listed);
  assert.equal(asArray(listed.addresses, "list.addresses").length, 2);
  assert.equal(asArray(listed.phones, "list.phones").length, 2);

  const keepAddress = asRecord(asArray(got.addresses, "get.addresses")[0]!);
  const keepPhone = asRecord(asArray(got.phones, "get.phones")[0]!);
  const patched = await mutateContact(
    clients,
    occ,
    "PATCH",
    contactId,
    {
      addresses: [
        { id: keepAddress.id, line1: "1 Main St", city: "London" },
      ],
      phones: [
        {
          id: keepPhone.id,
          number: "111-renamed",
          label: keepPhone.label,
        },
      ],
    },
    got.updated,
  );
  const patchedAddresses = asArray(patched.addresses, "patch.addresses");
  const patchedPhones = asArray(patched.phones, "patch.phones");
  assert.equal(patchedAddresses.length, 1);
  assert.equal(patchedPhones.length, 1);
  assert.equal(asRecord(patchedPhones[0]!).number, "111-renamed");

  const replaced = await mutateContact(
    clients,
    occ,
    "PUT",
    contactId,
    {
      first_name: "Nested",
      last_name: `Contact-${suffix}`,
      contact_source_name: "Manual",
      addresses: [{ line1: "9 Put St", city: "Bath" }],
      phones: [{ number: "999-9999", label: "mobile" }],
    },
    patched.updated,
  );
  assert.equal(asArray(replaced.addresses, "put.addresses").length, 1);
  assert.equal(asRecord(asArray(replaced.addresses, "put.addresses")[0]!).city, "Bath");
  assert.equal(asArray(replaced.phones, "put.phones").length, 1);

  const group = asRecord(
    await clients.groups.create({ name: `members-${suffix}` }),
  );
  const groupId = group.id;
  await assert.rejects(
    () =>
      clients.groups.create({
        name: `eager-members-${suffix}`,
        members: [
          {
            first_name: "Ghost",
            last_name: `Member-${suffix}`,
            contact_source_name: "Manual",
          },
        ],
      }),
    /failed: 400/,
  );
  const gotGroup = asRecord(await clients.groups.get(groupId));
  assert.equal(asArray(gotGroup.members ?? [], "get.members").length, 0);

  return { contactId, groupId };
};

const assertCombinedRoutes = async (
  clients: GraphClients,
  contactId: unknown,
  groupId: unknown,
): Promise<void> => {
  const { http } = clients;
  const createdAddress = asRecord(
    await http.request({
      method: "POST",
      path: `/api/contacts/${contactId}/addresses`,
      body: { line1: "Nested CRUD", city: "York" },
    }),
  );
  assert.equal(createdAddress.city, "York");

  const listedAddresses = itemsOf(
    await http.request({
      method: "GET",
      path: `/api/contacts/${contactId}/addresses`,
    }),
  );
  assert.ok(listedAddresses.some((row) => asRecord(row).id === createdAddress.id));

  const createdPhone = asRecord(
    await http.request({
      method: "POST",
      path: `/api/contacts/${contactId}/phones`,
      body: { number: "000-0000", label: "fax" },
    }),
  );
  assert.equal(createdPhone.label, "fax");

  await http.request({
    method: "DELETE",
    path: `/api/contacts/${contactId}/addresses/${createdAddress.id}`,
  });
  await assert.rejects(
    () =>
      http.request({
        method: "GET",
        path: `/api/contacts/${contactId}/addresses/${createdAddress.id}`,
      }),
    /failed: 404/,
  );

  const linked = asRecord(
    await http.request({
      method: "POST",
      path: `/api/contact-groups/${groupId}/members`,
      body: { contact_id: contactId },
    }),
  );
  assert.equal(linked.id, contactId);
  assert.equal(linked.contact_source_name, "Manual");
  assertNoFk(linked, "contact_source_id");

  const members = itemsOf(
    await http.request({
      method: "GET",
      path: `/api/contact-groups/${groupId}/members`,
    }),
  ).map(asRecord);
  assert.ok(members.some((row) => row.id === contactId));
  const member = members.find((row) => row.id === contactId);
  assert.ok(member);
  assert.equal(member.contact_source_name, "Manual");

  const gotGroup = asRecord(await clients.groups.get(groupId));
  const eagerMembers = asArray(gotGroup.members, "group.members").map(asRecord);
  assert.ok(eagerMembers.some((row) => row.id === contactId));
  assert.equal(
    asRecord(eagerMembers.find((row) => row.id === contactId)!).contact_source_name,
    "Manual",
  );

  const listedGroups = itemsOf(await clients.groups.list())
    .map(asRecord)
    .find((row) => row.id === groupId);
  assert.ok(listedGroups);
  assert.ok(
    asArray(listedGroups.members, "list.groups.members").some(
      (row) => asRecord(row).id === contactId,
    ),
  );

  await http.request({
    method: "DELETE",
    path: `/api/contact-groups/${groupId}/members/${contactId}`,
  });
  const afterRemove = itemsOf(
    await http.request({
      method: "GET",
      path: `/api/contact-groups/${groupId}/members`,
    }),
  );
  assert.equal(
    afterRemove.some((row) => asRecord(row).id === contactId),
    false,
  );
};

const assertOcc = async (
  clients: GraphClients,
  variant: ContactsVariant,
): Promise<void> => {
  if (!variant.useOptimisticConcurrency) return;
  const suffix = uniqueSuffix();
  const created = asRecord(
    await clients.contacts.create({
      first_name: "Occ",
      last_name: `Token-${suffix}`,
      contact_source_name: "Manual",
    }),
  );
  assert.equal(typeof created.updated, "string");
  const id = created.id;
  const path = `/api/contacts/${id}`;

  await assert.rejects(
    () =>
      clients.http.request({
        method: "PATCH",
        path,
        body: { first_name: "No-Match" },
      }),
    /failed: 428/,
  );

  await assert.rejects(
    () =>
      clients.http.request({
        method: "PATCH",
        path,
        body: { first_name: "Stale" },
        headers: ifMatchHeaders("1970-01-01T00:00:00.000Z"),
      }),
    /failed: 412/,
  );

  const fresh = asRecord(
    await clients.http.request({
      method: "PATCH",
      path,
      body: { first_name: "Fresh" },
      headers: ifMatchHeaders(created.updated),
    }),
  );
  assert.equal(fresh.first_name, "Fresh");

  const sourceRows = itemsOf(await clients.sources.list()).map(asRecord);
  const sourceId = sourceRows[0]?.id;
  assert.ok(sourceId !== undefined);
  await assert.rejects(
    () =>
      clients.http.request({
        method: "PATCH",
        path: `/api/contact-sources/${sourceId}`,
        body: { name: "ShouldFail" },
      }),
    /failed: 4\d\d/,
  );

  const group = asRecord(
    await clients.groups.create({ name: `occ-m2m-${suffix}` }),
  );
  const linked = asRecord(
    await clients.http.request({
      method: "POST",
      path: `/api/contact-groups/${group.id}/members`,
      body: { contact_id: id },
    }),
  );
  assert.equal(linked.id, id);
};

export const assertContactsGraph = async (
  booted: BootedContactsApp,
): Promise<void> => {
  await assertContactsLayout(booted);
  const clients = await loadGraphClients(booted);
  const occ = booted.variant.useOptimisticConcurrency;
  await assertEnrichment(clients, occ);
  const { contactId, groupId } = await assertEagerWriteAndRead(clients, occ);
  await assertCombinedRoutes(clients, contactId, groupId);
  await assertOcc(clients, booted.variant);
};

const runContactsVariant = (variant: ContactsVariant): void => {
  const tempPrefix = `ts-contacts-${variant.id}-`;
  describe(`contacts sample ${variant.id} e2e`, { timeout: 360_000 }, () => {
    let booted: BootedContactsApp | undefined;

    before(async () => {
      booted = await bootContactsSample(variant, tempPrefix);
    });

    after(async () => {
      if (booted !== undefined) dumpContactsTrace(booted);
      await stopGeneratedApp(booted, tempPrefix);
    });

    it("covers enrichment, eager graph, combined routes, and layout", async () => {
      assert.ok(booted);
      await assertContactsGraph(booted);
    });
  });
};

runContactsVariant(CONTACTS_VARIANTS.baseline);
runContactsVariant(CONTACTS_VARIANTS["by-feature-pascal"]);
runContactsVariant(CONTACTS_VARIANTS["occ-snake"]);
runContactsVariant(CONTACTS_VARIANTS["singular-camel"]);
runContactsVariant(CONTACTS_VARIANTS["snake-test"]);
