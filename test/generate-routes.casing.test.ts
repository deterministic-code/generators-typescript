import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { createCasing } from "../src/common/default-casing.ts";
import { generate } from "../src/generate-routes.ts";
import { createImportGenerator } from "../src/import-generator.ts";

const DS_YAML = `types:
  - contact:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - first_name:
            type: string
  - contact_group:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - name:
            type: string
  - contact_source:
      tags: [datasource_type, readonly_lookup]
      inherits: set
      fields:
        - name:
            type: string
            is_unique: true
`;

const ROUTES_YAML = `includes:
  - types:
      filter: 'tag == "view_type" || tag == "datasource_type"'
routes:
  - import_contacts:
      path: /api/contacts/import
      method: POST
  - migrate_legacy_contacts:
      path: /api/legacy-contacts/migrate
      method: POST
`;

const fixtureReader = () =>
  memoryReader({
    "types.yaml": DS_YAML,
    "routes.yaml": ROUTES_YAML,
  });

const entryBody = (entry: GenerateEntry): string => {
  if ("contents" in entry) return String(entry.contents);
  return entry.content;
};

const byFilename = async (settings: Record<string, string>) => {
  const map = new Map<string, string>();
  for (const entry of await generate({
    reader: fixtureReader(),
    settings,
  })) {
    map.set(entry.filename, entryBody(entry));
  }
  return map;
};

const serviceImportOf = (
  entity: string,
  settings: Record<string, string>,
): string => {
  const imports = createImportGenerator(".", settings);
  return imports.spec(imports.routeRel(entity), imports.serviceRel(entity));
};

const assertServiceImport = (
  body: string,
  entity: string,
  settings: Record<string, string>,
): void => {
  const spec = serviceImportOf(entity, settings);
  assert.ok(
    body.includes(`from "${spec}"`),
    `expected import from ${spec}; got:\n${body}`,
  );
};

const CUSTOM_ROUTES_YAML = `includes:
  - types:
      filter: 'tag == "view_type" || tag == "datasource_type"'
routes:
  - import_contacts:
      path: /api/contacts/import
      method: POST
  - migrate_legacy_contacts:
      path: /api/legacy-contacts/migrate
      method: POST
  - echo:
      path: /api/echo
      method: GET
      routeClass: EchoRoute
      module: ./routes/echo-route
`;

const generateCustomRoutes = async (settings: Record<string, string>) => {
  const files = new Map<string, string>();
  for (const entry of await generate({
    reader: memoryReader({
      "types.yaml": DS_YAML,
      "routes.yaml": CUSTOM_ROUTES_YAML,
    }),
    settings,
  })) {
    files.set(entry.filename, entryBody(entry));
  }
  return { files, casing: createCasing(settings) };
};

const customStubPath = (
  casing: ReturnType<typeof createCasing>,
  name: string,
): string => `../custom/${casing.fileBase(`${name}_route`)}.ts`;

const assertPairedStub = (
  body: string,
  className: string,
  interfaceName: string,
): void => {
  assert.match(body, new RegExp(`export interface ${interfaceName} \\{`));
  assert.match(
    body,
    new RegExp(`export class ${className} implements ${interfaceName}`),
  );
  assert.match(body, new RegExp(`error: "stub route ${className}"`));
};

const assertCustomIndexExports = (
  index: string,
  pairs: ReadonlyArray<readonly [string, string, string]>,
): void => {
  for (const [className, interfaceName, fileBase] of pairs) {
    assert.match(
      index,
      new RegExp(`export \\{ ${className} \\} from "\\./${fileBase}"`),
    );
    assert.match(
      index,
      new RegExp(`export type \\{ ${interfaceName} \\} from "\\./${fileBase}"`),
    );
  }
};

describe("generate routes casing", () => {
  it("Auto uses Camel files, Pascal types, and IContactService", async () => {
    const settings = {};
    const files = await byFilename(settings);
    assert.ok(files.has("contact.ts"));
    assert.ok(files.has("contactGroup.ts"));
    const contact = files.get("contact.ts")!;
    const group = files.get("contactGroup.ts")!;
    assert.match(contact, /IContactService/);
    assert.match(group, /IContactGroupService/);
    assert.match(contact, /export function ContactRouter/);
    assert.match(group, /export function ContactGroupRouter/);
    assertServiceImport(contact, "contact", settings);
    assertServiceImport(group, "contact_group", settings);
    assert.doesNotMatch(contact, /IcontactService/);
  });

  it("Pascal file names", async () => {
    const files = await byFilename({
      "languages.typescript.casing.file_names": "Pascal",
    });
    assert.ok(files.has("Contact.ts"));
    assert.ok(files.has("ContactGroup.ts"));
    assert.match(files.get("Contact.ts")!, /IContactService/);
    assert.match(files.get("ContactGroup.ts")!, /IContactGroupService/);
  });

  it("Snake file names", async () => {
    const files = await byFilename({
      "languages.typescript.casing.file_names": "Snake",
    });
    assert.ok(files.has("contact.ts"));
    assert.ok(files.has("contact_group.ts"));
    assert.match(files.get("contact.ts")!, /IContactService/);
    assert.match(files.get("contact_group.ts")!, /IContactGroupService/);
  });

  it("Pascal types use IContactService / IContactGroupService", async () => {
    const settings = { "languages.typescript.casing.types": "Pascal" };
    const files = await byFilename(settings);
    const contact = files.get("contact.ts")!;
    const group = files.get("contactGroup.ts")!;
    assert.match(contact, /IContactService/);
    assert.match(group, /IContactGroupService/);
    assertServiceImport(contact, "contact", settings);
  });

  it("Snake types use i_contact_service / i_contact_group_service", async () => {
    const settings = { "languages.typescript.casing.types": "Snake" };
    const files = await byFilename(settings);
    const contact = files.get("contact.ts")!;
    const group = files.get("contactGroup.ts")!;
    const source = files.get("contactSource.ts")!;
    assert.match(contact, /i_contact_service/);
    assert.match(group, /i_contact_group_service/);
    assert.match(contact, /export function contact_router/);
    assert.match(group, /export function contact_group_router/);
    assert.match(source, /i_contact_source_service/);
    assert.doesNotMatch(contact, /IcontactService/);
    assert.doesNotMatch(contact, /Icontact_service/);
    assert.doesNotMatch(group, /Icontact_groupService/);
    assertServiceImport(contact, "contact", settings);
    assertServiceImport(group, "contact_group", settings);
  });

  it("Kebab directories with Pascal files under by-feature", async () => {
    const files = await byFilename({
      "other.organize_by_feature": "true",
      "languages.typescript.casing.file_names": "Pascal",
      "languages.typescript.casing.directories": "Kebab",
    });
    assert.ok(files.has("features/contact/Contact.route.ts"));
    assert.ok(files.has("features/contact-group/ContactGroup.route.ts"));
    assert.match(files.get("features/contact/Contact.route.ts")!, /IContactService/);
  });

  it("keeps authored custom route class names for runtime load", async () => {
    const { files } = await generateCustomRoutes({
      "languages.typescript.casing.types": "Snake",
    });
    const echo = files.get("../echo-route.ts");
    assert.ok(echo, `missing echo-route; got ${[...files.keys()].join(", ")}`);
    assert.match(echo, /export class EchoRoute /);
    assert.doesNotMatch(echo, /export class echo_route /);
  });
});

describe("custom route class and interface casing", () => {
  it("pairs Pascal class and I-prefixed interface from YAML keys", async () => {
    const { files, casing } = await generateCustomRoutes({});
    const importPath = customStubPath(casing, "import_contacts");
    const migratePath = customStubPath(casing, "migrate_legacy_contacts");
    const healthPath = customStubPath(casing, "getHealth");
    assertPairedStub(files.get(importPath)!, "ImportContacts", "IImportContacts");
    assertPairedStub(
      files.get(migratePath)!,
      "MigrateLegacyContacts",
      "IMigrateLegacyContacts",
    );
    assertPairedStub(files.get(healthPath)!, "GetHealth", "IGetHealth");
    assert.doesNotMatch(files.get(importPath)!, /export class import_contacts /);
    assert.doesNotMatch(
      files.get(migratePath)!,
      /export class migrate_legacy_contacts /,
    );
    assert.doesNotMatch(files.get(healthPath)!, /export class getHealth /);
    const index = files.get("../custom/index.ts");
    assert.ok(index, `missing custom index; got ${[...files.keys()].join(", ")}`);
    assertCustomIndexExports(index, [
      ["GetHealth", "IGetHealth", casing.fileBase("getHealth_route")],
      ["ImportContacts", "IImportContacts", casing.fileBase("import_contacts_route")],
      [
        "MigrateLegacyContacts",
        "IMigrateLegacyContacts",
        casing.fileBase("migrate_legacy_contacts_route"),
      ],
    ]);
  });

  it("pairs snake class and i_ interface when types are Snake", async () => {
    const { files, casing } = await generateCustomRoutes({
      "languages.typescript.casing.types": "Snake",
    });
    const importPath = customStubPath(casing, "import_contacts");
    const migratePath = customStubPath(casing, "migrate_legacy_contacts");
    const healthPath = customStubPath(casing, "getHealth");
    assertPairedStub(files.get(importPath)!, "import_contacts", "i_import_contacts");
    assertPairedStub(
      files.get(migratePath)!,
      "migrate_legacy_contacts",
      "i_migrate_legacy_contacts",
    );
    assertPairedStub(files.get(healthPath)!, "get_health", "i_get_health");
    assert.doesNotMatch(files.get(importPath)!, /export class ImportContacts /);
    assert.doesNotMatch(files.get(healthPath)!, /export class GetHealth /);
    assert.doesNotMatch(files.get(healthPath)!, /export class getHealth /);
    const index = files.get("../custom/index.ts")!;
    assertCustomIndexExports(index, [
      ["get_health", "i_get_health", casing.fileBase("getHealth_route")],
      ["import_contacts", "i_import_contacts", casing.fileBase("import_contacts_route")],
      [
        "migrate_legacy_contacts",
        "i_migrate_legacy_contacts",
        casing.fileBase("migrate_legacy_contacts_route"),
      ],
    ]);
  });

  it("keeps explicit routeClass and cases its interface", async () => {
    const pascal = await generateCustomRoutes({});
    assertPairedStub(pascal.files.get("../echo-route.ts")!, "EchoRoute", "IEchoRoute");
    assert.doesNotMatch(pascal.files.get("../custom/index.ts")!, /EchoRoute/);

    const snake = await generateCustomRoutes({
      "languages.typescript.casing.types": "Snake",
    });
    assertPairedStub(snake.files.get("../echo-route.ts")!, "EchoRoute", "i_echo_route");
    assert.doesNotMatch(snake.files.get("../echo-route.ts")!, /export class echo_route /);
  });

  it("cases custom stubs under by-feature layout", async () => {
    const settings = {
      "other.organize_by_feature": "true",
      "languages.typescript.casing.file_names": "Pascal",
      "languages.typescript.casing.directories": "Kebab",
    };
    const { files } = await generateCustomRoutes(settings);
    const importBody = [...files.entries()].find(([path]) =>
      path.includes("ImportContacts"),
    )?.[1];
    assert.ok(
      importBody,
      `missing import_contacts stub; got ${[...files.keys()].join(", ")}`,
    );
    assertPairedStub(importBody, "ImportContacts", "IImportContacts");
  });
});
