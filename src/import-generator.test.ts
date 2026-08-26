import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createImportGenerator } from "./import-generator.ts";

const layered = () => createImportGenerator(".", {});
const byFeature = (extra: Record<string, string> = {}) =>
  createImportGenerator(".", {
    "other.organize_by_feature": "true",
    ...extra,
  });
const flat = (basePath: string, extra: Record<string, string> = {}) =>
  createImportGenerator(basePath, extra);

describe("TypeScriptImportGenerator layered (organize_by_feature unset)", () => {
  it("emits identity files and prefixed Rel paths", () => {
    const imports = layered();
    assert.equal(imports.datasource("user"), "user.ts");
    assert.equal(imports.datasourceRel("user"), "types/generated/datasource/user.ts");
    assert.equal(imports.datasourceQual("user"), "User");
    assert.equal(imports.datasourceValidator("user"), "user.ts");
    assert.equal(
      imports.datasourceValidatorRel("user"),
      "types/generated/datasource/validators/user.ts",
    );
    assert.equal(
      imports.datasourceTestRel("user"),
      "types/generated/datasource/user.test.ts",
    );
    assert.equal(
      imports.datasourceValidatorTestRel("user"),
      "types/generated/datasource/validators/user.test.ts",
    );
    assert.equal(
      imports.validatorTestRel("datasource", "user"),
      "types/generated/datasource/validators/user.test.ts",
    );
    assert.equal(imports.view("card_payment"), "cardPayment.ts");
    assert.equal(
      imports.viewRel("card_payment"),
      "types/generated/views/cardPayment.ts",
    );
    assert.equal(imports.viewQual("card_payment"), "CardPayment");
    assert.equal(imports.viewValidator("card_payment"), "cardPayment.ts");
    assert.equal(
      imports.viewValidatorRel("card_payment"),
      "types/generated/views/validators/cardPayment.ts",
    );
    assert.equal(
      imports.viewTestRel("card_payment"),
      "types/generated/views/cardPayment.test.ts",
    );
    assert.equal(
      imports.viewValidatorTestRel("card_payment"),
      "types/generated/views/validators/cardPayment.test.ts",
    );
    assert.equal(
      imports.validatorTestRel("view", "card_payment"),
      "types/generated/views/validators/cardPayment.test.ts",
    );
    assert.equal(imports.service("user"), "userService.ts");
    assert.equal(imports.serviceRel("user"), "services/generated/userService.ts");
    assert.equal(imports.serviceTest("user"), "userService.test.ts");
    assert.equal(
      imports.serviceTestRel("user"),
      "services/generated/__tests__/userService.test.ts",
    );
    assert.equal(
      imports.serviceIntegrationTest("user"),
      "userService.integration.test.ts",
    );
    assert.equal(
      imports.serviceIntegrationTestRel("user"),
      "services/generated/__tests__/userService.integration.test.ts",
    );
    assert.equal(imports.serviceCustomRel("user"), "services/custom/userService.ts");
    assert.equal(imports.route("user"), "user.ts");
    assert.equal(imports.routeRel("user"), "routes/generated/user.ts");
    assert.equal(imports.routeTest("user"), "user.integration.test.ts");
    assert.equal(
      imports.routeTestRel("user"),
      "routes/generated/__tests__/user.integration.test.ts",
    );
    assert.equal(imports.routeModule("user"), "user");
    assert.equal(imports.index("user.ts"), "index.ts");
    assert.equal(imports.index("types/user.ts"), "types/index.ts");
    assert.equal(imports.test("user.ts", "user"), "user.test.ts");
    assert.equal(imports.testSpec("user.ts", "user"), "../user");
    assert.equal(imports.testSpec("features/user/user.ts", "user"), "./user");
    assert.equal(imports.spec("user_service.ts", "user.ts"), "./user");
    assert.equal(imports.spec("a.ts", "b.ts"), "./b");
    assert.equal(imports.spec("dir/a.ts", "dir/b.ts"), "./b");
    assert.equal(imports.spec("dir/a.ts", "other.ts"), "../other");
    assert.equal(imports.spec("a.ts", "nested/b.ts"), "./nested/b");
    assert.equal(imports.spec("a.ts", "nested/b"), "./nested/b");
    assert.equal(imports.serviceUse("user", "UserService"), "");
    assert.equal(imports.enrichment("role"), "");
    assert.equal(imports.appWiring(), "");
    assert.equal(imports.validatorFn("datasource", "user", "parse"), "");
    assert.equal(imports.validatorFn("view", "user", "parse"), "");
    assert.equal(imports.apiPath("card_payment"), "card-payment");
    assert.equal(imports.frontend("src/App.tsx"), "frontend/src/App.tsx");
    assert.equal(imports.frontend("src/types"), "frontend/src/types");
    assert.equal(imports.app(), "app.ts");
    assert.equal(imports.server(), "server.ts");
    assert.equal(imports.appTest("health"), "__tests__/health.test.ts");
    assert.equal(imports.appTest("app_boot"), "__tests__/appBoot.test.ts");
    assert.deepEqual(imports.tsconfigIncludes(), [
      "types/**/*.ts",
      "services/**/*.ts",
      "routes/**/*.ts",
    ]);
  });

  it("cases file names from settings for every lane", () => {
    const camel = layered();
    assert.equal(camel.datasource("notification_type"), "notificationType.ts");
    assert.equal(camel.view("notification_type"), "notificationType.ts");
    assert.equal(camel.service("notification_type"), "notificationTypeService.ts");
    assert.equal(camel.route("notification_type"), "notificationType.ts");
    assert.equal(camel.datasourceQual("notification_type"), "NotificationType");
    assert.equal(camel.viewQual("notification_type"), "NotificationType");
    const pascal = createImportGenerator(".", {
      "languages.typescript.casing.file_names": "Pascal",
    });
    assert.equal(pascal.app(), "App.ts");
    assert.equal(pascal.server(), "Server.ts");
    assert.equal(pascal.appTest("app_boot"), "__tests__/AppBoot.test.ts");
    assert.equal(pascal.datasource("notification_type"), "NotificationType.ts");
    assert.equal(pascal.view("notification_type"), "NotificationType.ts");
    assert.equal(pascal.service("notification_type"), "NotificationTypeService.ts");
    assert.equal(pascal.route("notification_type"), "NotificationType.ts");
    const snake = createImportGenerator(".", {
      "languages.typescript.casing.file_names": "Snake",
    });
    assert.equal(snake.datasource("notification_type"), "notification_type.ts");
    assert.equal(snake.service("notification_type"), "notification_type_service.ts");
    const kebab = createImportGenerator(".", {
      "languages.typescript.casing.file_names": "Kebab",
    });
    assert.equal(kebab.datasource("notification_type"), "notification-type.ts");
    assert.equal(kebab.view("notification_type"), "notification-type.ts");
  });

  it("cases type quals from settings independently of files", () => {
    const snakeTypes = createImportGenerator(".", {
      "languages.typescript.casing.types": "Snake",
    });
    assert.equal(snakeTypes.datasource("notification_type"), "notificationType.ts");
    assert.equal(
      snakeTypes.datasourceQual("notification_type"),
      "notification_type",
    );
    assert.equal(snakeTypes.viewQual("notification_type"), "notification_type");
  });

  it("treats organize_by_feature values other than true as layered", () => {
    for (const value of ["", "false", "TRUE", "1", "yes"]) {
      const imports = createImportGenerator(".", {
        "other.organize_by_feature": value,
      });
      assert.equal(imports.datasource("user"), "user.ts", value);
      assert.equal(imports.index("user.ts"), "index.ts", value);
      assert.equal(
        imports.datasourceRel("user"),
        "types/generated/datasource/user.ts",
        value,
      );
    }
  });

  it("resolves custom service stubs from module paths", () => {
    const imports = layered();
    assert.equal(imports.serviceCustom("user"), "../custom/user.ts");
    assert.equal(imports.serviceCustom("user", undefined), "../custom/user.ts");
    assert.equal(imports.serviceCustom("user", ""), "../custom/user.ts");
    assert.equal(imports.serviceCustom("user", "custom/user"), "../custom/user.ts");
    assert.equal(
      imports.serviceCustom("user", "./services/custom/user"),
      "../custom/user.ts",
    );
    assert.equal(imports.serviceCustom("user", "./custom/user"), "../custom/user.ts");
    assert.equal(
      imports.serviceCustom("user", "./../custom/user"),
      "../custom/user.ts",
    );
  });

  it("resolves custom route stubs from module paths", () => {
    const imports = layered();
    assert.equal(imports.routeCustom("get_health"), "../custom/getHealthRoute.ts");
    assert.equal(
      imports.routeCustom("get_health", "./routes/custom/get_health_route"),
      "../custom/get_health_route.ts",
    );
    assert.equal(
      imports.routeCustom("get_health", "./custom/get_health_route"),
      "../custom/get_health_route.ts",
    );
  });
});

describe("TypeScriptImportGenerator by-feature", () => {
  it("nests every lane under features/<entity>/", () => {
    const imports = byFeature();
    assert.equal(imports.datasource("user"), "features/user/user.datasource.ts");
    assert.equal(imports.datasourceRel("user"), "features/user/user.datasource.ts");
    assert.equal(
      imports.datasourceValidator("user"),
      "features/user/user.datasource.validator.ts",
    );
    assert.equal(
      imports.datasourceValidatorRel("user"),
      "features/user/user.datasource.validator.ts",
    );
    assert.equal(
      imports.datasourceTestRel("user"),
      "features/user/__tests__/user.datasource.test.ts",
    );
    assert.equal(
      imports.datasourceValidatorTestRel("user"),
      "features/user/__tests__/user.datasource.validator.test.ts",
    );
    assert.equal(imports.view("card_payment"), "features/cardPayment/cardPayment.ts");
    assert.equal(
      imports.view("create_card_payment"),
      "features/cardPayment/createCardPayment.ts",
    );
    assert.equal(
      imports.view("update_card_payment"),
      "features/cardPayment/updateCardPayment.ts",
    );
    assert.equal(
      imports.viewValidator("create_card_payment"),
      "features/cardPayment/createCardPayment.validator.ts",
    );
    assert.equal(imports.viewValidatorRel("user"), "features/user/user.validator.ts");
    assert.equal(imports.viewRel("user"), "features/user/user.ts");
    assert.equal(
      imports.viewTestRel("user"),
      "features/user/__tests__/user.test.ts",
    );
    assert.equal(
      imports.viewValidatorTestRel("user"),
      "features/user/__tests__/user.validator.test.ts",
    );
    assert.equal(imports.service("user"), "features/user/userService.ts");
    assert.equal(imports.serviceRel("user"), "features/user/userService.ts");
    assert.equal(
      imports.serviceTest("user"),
      "features/user/__tests__/userService.test.ts",
    );
    assert.equal(
      imports.serviceTestRel("user"),
      "features/user/__tests__/userService.test.ts",
    );
    assert.equal(
      imports.serviceIntegrationTest("user"),
      "features/user/__tests__/userService.integration.test.ts",
    );
    assert.equal(
      imports.serviceIntegrationTestRel("user"),
      "features/user/__tests__/userService.integration.test.ts",
    );
    assert.equal(
      imports.serviceCustomRel("user"),
      "features/user/custom/userService.ts",
    );
    assert.equal(imports.route("user"), "features/user/user.route.ts");
    assert.equal(imports.routeRel("user"), "features/user/user.route.ts");
    assert.equal(
      imports.routeTest("user"),
      "features/user/__tests__/user.integration.test.ts",
    );
    assert.equal(
      imports.routeTestRel("user"),
      "features/user/__tests__/user.integration.test.ts",
    );
    assert.equal(imports.index("features/user/user.ts"), "");
    assert.equal(
      imports.test("features/user/user.ts", "user"),
      "features/user/__tests__/user.test.ts",
    );
    assert.equal(imports.testSpec("features/user/user.ts", "user"), "../user");
    assert.equal(
      imports.spec("features/user/userService.ts", "features/user/user.ts"),
      "./user",
    );
    assert.equal(imports.frontend("src/App.tsx"), "frontend/src/App.tsx");
    assert.deepEqual(imports.tsconfigIncludes(), ["features/**/*.ts"]);
  });

  it("cases files and feature directories together for every lane", () => {
    const camel = byFeature();
    assert.equal(
      camel.datasource("notification_type"),
      "features/notificationType/notificationType.datasource.ts",
    );
    assert.equal(
      camel.view("notification_type"),
      "features/notificationType/notificationType.ts",
    );
    assert.equal(
      camel.service("notification_type"),
      "features/notificationType/notificationTypeService.ts",
    );
    assert.equal(
      camel.route("notification_type"),
      "features/notificationType/notificationType.route.ts",
    );
    const imports = byFeature({
      "languages.typescript.casing.file_names": "Pascal",
      "languages.typescript.casing.directories": "Kebab",
    });
    assert.equal(
      imports.datasource("notification_type"),
      "features/notification-type/NotificationType.datasource.ts",
    );
    assert.equal(
      imports.view("notification_type"),
      "features/notification-type/NotificationType.ts",
    );
    assert.equal(
      imports.service("notification_type"),
      "features/notification-type/NotificationTypeService.ts",
    );
    const snakeDirs = byFeature({
      "languages.typescript.casing.file_names": "Snake",
      "languages.typescript.casing.directories": "Snake",
    });
    assert.equal(
      snakeDirs.datasource("notification_type"),
      "features/notification_type/notification_type.datasource.ts",
    );
    assert.equal(
      snakeDirs.service("notification_type"),
      "features/notification_type/notification_type_service.ts",
    );
  });

  it("uses convention custom stubs when module is missing or layered", () => {
    const imports = byFeature();
    assert.equal(imports.serviceCustom("user"), "features/user/custom/user.ts");
    assert.equal(
      imports.serviceCustom("user", 1 as unknown as string),
      "features/user/custom/user.ts",
    );
    assert.equal(
      imports.serviceCustom("user", undefined),
      "features/user/custom/user.ts",
    );
    assert.equal(
      imports.serviceCustom("user", "./services/custom/user"),
      "features/user/custom/user.ts",
    );
    assert.equal(
      imports.serviceCustom("user", "./routes/custom/user"),
      "features/user/custom/user.ts",
    );
    assert.equal(
      imports.routeCustom("get_health"),
      "features/getHealth/custom/getHealthRoute.ts",
    );
    assert.equal(
      imports.routeCustom("get_health", "./routes/custom/get_health"),
      "features/getHealth/custom/getHealthRoute.ts",
    );
  });

  it("accepts a module path under ./features/", () => {
    const imports = byFeature();
    assert.equal(
      imports.serviceCustom("user", "./features/user/custom/user"),
      "features/user/custom/user.ts",
    );
    assert.equal(
      imports.routeCustom("get_health", "./features/health/custom/get_health_route"),
      "features/health/custom/get_health_route.ts",
    );
    assert.equal(
      imports.serviceCustom("user", "././features/shared/custom/user"),
      "features/shared/custom/user.ts",
    );
  });

  it("rejects a custom module outside ./features/", () => {
    const imports = byFeature();
    assert.throws(
      () => imports.serviceCustom("user", "./lib/user"),
      /generateCustomServiceStub: service "user" has module "\.\/lib\/user" which is outside \.\/features\//,
    );
    assert.throws(
      () => imports.routeCustom("get_health", "./lib/get_health"),
      /generateCustomRouteStub: route "get_health" has module "\.\/lib\/get_health" which is outside \.\/features\//,
    );
  });
});

describe("TypeScriptImportGenerator flat basePath", () => {
  it("ignores organize_by_feature and prefixes frontend dirs", () => {
    const viewDir = layered().frontend("src/types");
    const imports = flat(viewDir, { "other.organize_by_feature": "true" });
    assert.equal(imports.view("user"), "frontend/src/types/user.ts");
    assert.equal(imports.viewRel("user"), "frontend/src/types/user.ts");
    assert.equal(imports.datasource("user"), "frontend/src/types/user.ts");
    assert.equal(imports.datasourceRel("user"), "frontend/src/types/user.ts");
    assert.equal(
      imports.index("frontend/src/types/user.ts"),
      "frontend/src/types/index.ts",
    );
    assert.equal(
      imports.test("frontend/src/types/user.ts", "user"),
      "frontend/src/types/user.test.ts",
    );
    assert.deepEqual(imports.tsconfigIncludes(), []);
  });

  it("places validators under frontend/src/validators", () => {
    const imports = flat(layered().frontend("src/validators"), {});
    assert.equal(imports.viewValidator("user"), "frontend/src/validators/user.ts");
    assert.equal(
      imports.viewValidatorRel("user"),
      "frontend/src/validators/user.ts",
    );
  });

  it("treats empty basePath as backend layout, not flat", () => {
    const imports = createImportGenerator("", {
      "other.organize_by_feature": "true",
    });
    assert.equal(imports.datasource("user"), "features/user/user.datasource.ts");
  });
});
