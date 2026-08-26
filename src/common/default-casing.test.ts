import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCasing } from "./default-casing.ts";

const NAME = "notification_type";

describe("createCasing Auto defaults", () => {
  it("matches Default Casings for TypeScript", () => {
    const casing = createCasing({});
    assert.equal(casing.convertFileName(NAME), "notificationType");
    assert.equal(casing.convertTypes(NAME), "NotificationType");
    assert.equal(casing.convertFields(NAME), "notification_type");
    assert.equal(casing.convertDirectories(NAME), "notificationType");
    assert.equal(casing.filePath(NAME), "notificationType.ts");
    assert.equal(casing.serviceClassName("user"), "UserService");
    assert.equal(casing.serviceInterfaceName("user"), "IUserService");
    assert.equal(casing.serviceInterfaceName("contact"), "IContactService");
    assert.equal(
      casing.serviceInterfaceName("contact_group"),
      "IContactGroupService",
    );
    assert.equal(
      casing.authoredInterfaceName("ContactImportService"),
      "IContactImportService",
    );
    assert.equal(casing.finderMethod("channel_name"), "find_by_channel_name");
    assert.equal(casing.schemaName("contact_group"), "ContactGroupSchema");
    assert.equal(
      casing.schemaName("create_contact_group"),
      "CreateContactGroupSchema",
    );
    assert.equal(
      casing.validatedTypeName("contact_group"),
      "ContactGroupValidated",
    );
    assert.equal(casing.routerFnName("contact_group"), "ContactGroupRouter");
    assert.equal(casing.hookName("contact_group", "list"), "UseContactGroupList");
    assert.equal(casing.convertTypes("getHealth"), "GetHealth");
    assert.equal(casing.convertTypes("import_contacts"), "ImportContacts");
    assert.equal(
      casing.convertTypes("ContactImportService"),
      "ContactImportService",
    );
    assert.equal(casing.baseTypeName("contact"), "ContactBase");
    assert.equal(casing.clientName("contact_source"), "ContactSourceClient");
    assert.equal(
      casing.clientQueryOptionsName("contact_source"),
      "ContactSourceClientQueryOptions",
    );
    assert.equal(
      casing.clientMutationOptionsName("contact_source"),
      "ContactSourceClientMutationOptions",
    );
    assert.equal(casing.appFnName(), "CreateBackendApp");
    assert.equal(casing.appComponentName(), "App");
    assert.equal(casing.homeComponentName(), "Home");
    assert.equal(casing.rootLayoutName(), "RootLayout");
    assert.equal(casing.appConfigName(), "AppConfig");
    assert.equal(casing.filePath("app"), "app.ts");
    assert.equal(casing.filePath("server"), "server.ts");
    assert.equal(casing.fileBase("app_boot"), "appBoot");
  });
});

describe("createCasing overrides", () => {
  it("pascals file names", () => {
    const casing = createCasing({
      "languages.typescript.casing.file_names": "Pascal",
    });
    assert.equal(casing.filePath(NAME), "NotificationType.ts");
    assert.equal(casing.convertTypes(NAME), "NotificationType");
    assert.equal(casing.convertFields(NAME), "notification_type");
  });

  it("kebabs file names and directories", () => {
    const casing = createCasing({
      "languages.typescript.casing.file_names": "Kebab",
      "languages.typescript.casing.directories": "Kebab",
    });
    assert.equal(casing.fileBase(NAME), "notification-type");
    assert.equal(casing.directory(NAME), "notification-type");
  });

  it("snakes type names", () => {
    const casing = createCasing({
      "languages.typescript.casing.types": "Snake",
    });
    assert.equal(casing.convertTypes(NAME), "notification_type");
    assert.equal(casing.serviceClassName("contact"), "contact_service");
    assert.equal(casing.serviceInterfaceName("contact"), "i_contact_service");
    assert.equal(
      casing.serviceInterfaceName("contact_group"),
      "i_contact_group_service",
    );
    assert.notEqual(
      casing.serviceInterfaceName("contact_group"),
      `I${casing.serviceClassName("contact_group")}`,
    );
    assert.equal(casing.schemaName("contact_group"), "contact_group_schema");
    assert.equal(
      casing.schemaName("create_contact_group"),
      "create_contact_group_schema",
    );
    assert.equal(
      casing.validatedTypeName("contact_group"),
      "contact_group_validated",
    );
    assert.equal(casing.routerFnName("contact"), "contact_router");
    assert.equal(
      casing.hookName("contact_group", "list"),
      "use_contact_group_list",
    );
    assert.equal(
      casing.authoredInterfaceName("ContactImportService"),
      "i_contact_import_service",
    );
    assert.equal(casing.convertTypes("getHealth"), "get_health");
    assert.equal(casing.convertTypes("import_contacts"), "import_contacts");
    assert.equal(
      casing.convertTypes("ContactImportService"),
      "contact_import_service",
    );
    assert.equal(casing.baseTypeName("contact"), "contact_base");
    assert.equal(casing.clientName("contact_source"), "contact_source_client");
    assert.equal(
      casing.clientQueryOptionsName("contact_source"),
      "contact_source_client_query_options",
    );
    assert.equal(casing.appFnName(), "create_backend_app");
    assert.equal(casing.appComponentName(), "app");
    assert.equal(casing.homeComponentName(), "home");
    assert.equal(casing.rootLayoutName(), "root_layout");
    assert.equal(casing.appConfigName(), "app_config");
  });

  it("camels type names and wraps I with every token", () => {
    const casing = createCasing({
      "languages.typescript.casing.types": "Camel",
    });
    assert.equal(casing.convertTypes(NAME), "notificationType");
    assert.equal(casing.serviceClassName("contact"), "contactService");
    assert.equal(casing.serviceInterfaceName("contact"), "iContactService");
    assert.equal(
      casing.serviceInterfaceName("contact_group"),
      "iContactGroupService",
    );
    assert.equal(
      casing.serviceInterfaceName("notification_type"),
      "iNotificationTypeService",
    );
    assert.equal(
      casing.authoredInterfaceName("ContactImportService"),
      "iContactImportService",
    );
    assert.notEqual(
      casing.serviceInterfaceName("contact_group"),
      `I${casing.serviceClassName("contact_group")}`,
    );
  });

  it("camels fields", () => {
    const casing = createCasing({
      "languages.typescript.casing.fields": "Camel",
    });
    assert.equal(casing.convertFields("role_id"), "roleId");
    assert.equal(casing.fieldIdent("role_id"), "roleId");
    assert.equal(casing.finderMethod("channel_name"), "findByChannelName");
  });

  it("pascals fields", () => {
    const casing = createCasing({
      "languages.typescript.casing.fields": "Pascal",
    });
    assert.equal(casing.convertFields("role_id"), "RoleId");
  });

  it("kebabs fields", () => {
    const casing = createCasing({
      "languages.typescript.casing.fields": "Kebab",
    });
    assert.equal(casing.convertFields("role_id"), "role-id");
    assert.equal(casing.fieldIdent("role_id"), '"role-id"');
  });

  it("snakes directories independently of files", () => {
    const casing = createCasing({
      "languages.typescript.casing.file_names": "Pascal",
      "languages.typescript.casing.directories": "Snake",
    });
    assert.equal(casing.fileBase(NAME), "NotificationType");
    assert.equal(casing.directory(NAME), "notification_type");
  });
});
