import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileReader } from "@deterministic-code/generators-common/deterministic-reader";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate as generateSql } from "../../generators-sql/src/generate-sql.ts";
import { createImportGenerator } from "../src/import-generator.ts";
import { generate as generateBackendApp } from "../src/generate-backend-app.ts";
import { generate as generateClientBindingsLiveTests } from "../src/generate-client-bindings-live-tests.ts";
import { generate as generateClientBindingsMockTests } from "../src/generate-client-bindings-mock-tests.ts";
import { generate as generateClientBindings } from "../src/generate-client-bindings.ts";
import { generate as generateDatasourceTypeValidatorsTests } from "../src/generate-datasource-type-validators-tests.ts";
import { generate as generateDatasourceTypeValidators } from "../src/generate-datasource-type-validators.ts";
import { generate as generateDatasourceTypesTests } from "../src/generate-datasource-types-tests.ts";
import { generate as generateDatasourceTypes } from "../src/generate-datasource-types.ts";
import { generate as generateFrontendApp } from "../src/generate-frontend-app.ts";
import { generate as generateFrontendTypesTests } from "../src/generate-frontend-types-tests.ts";
import { generate as generateFrontendTypes } from "../src/generate-frontend-types.ts";
import { generate as generateFrontendValidatorsTests } from "../src/generate-frontend-validators-tests.ts";
import { generate as generateFrontendValidators } from "../src/generate-frontend-validators.ts";
import { generate as generateRoutesE2eTest } from "../src/generate-routes-e2e-test.ts";
import { generate as generateRoutesTests } from "../src/generate-routes-tests.ts";
import { generate as generateRoutes } from "../src/generate-routes.ts";
import { generate as generateServiceIntegrationTests } from "../src/generate-service-integration-tests.ts";
import { generate as generateServiceTests } from "../src/generate-service-tests.ts";
import { generate as generateServices } from "../src/generate-services.ts";
import { generate as generateViewTypeValidatorsTests } from "../src/generate-view-type-validators-tests.ts";
import { generate as generateViewTypeValidators } from "../src/generate-view-type-validators.ts";
import { generate as generateViewTypesTests } from "../src/generate-view-types-tests.ts";
import { generate as generateViewTypes } from "../src/generate-view-types.ts";
import { removeE2eTempDirs } from "./cleanup-temp.ts";
import {
  CONTACTS_FIXTURE_DIR,
  loadContactsSample,
  type ContactsSample,
  type ContactsVariant,
} from "./contacts-sample-yaml.ts";
import {
  generateBundledMigrate,
  installFrontend,
  installBuildAndMigrateSqlite,
  testFrontend,
  sqliteAppEnv,
  startGeneratedServer,
  withSqlRoot,
  writeDeterministicYaml,
  type BootedApp,
} from "./generated-app.ts";
import {
  dumpCodegenEntries,
  dumpFinalFiles,
  dumpServerTrace,
  verboseOutputEnabled,
} from "./verbose-output.ts";
import { writeGenerateEntries } from "./write-generate-entries.ts";

const isRootPatch = (entry: GenerateEntry): boolean =>
  entry.kind === "patch" && !entry.filename.includes("/");

const nestUnder = (dir: string, entries: GenerateEntry[]): GenerateEntry[] =>
  entries.map((entry) =>
    isRootPatch(entry)
      ? entry
      : {
          ...entry,
          filename: posix.normalize(`${dir}/${entry.filename}`),
        },
  );

const filenames = (entries: GenerateEntry[]): string[] =>
  entries.map((entry) => entry.filename);

const stem = (value: string): string =>
  value.replace(/[-_./]/g, "").toLowerCase();

const requireNamed = (entries: GenerateEntry[], needle: string): void => {
  const want = stem(needle);
  const hit = filenames(entries).some((name) => stem(name).includes(want));
  if (!hit) {
    throw new Error(
      `codegen missing ${needle}; got ${filenames(entries).join(", ")}`,
    );
  }
};

const requireNamedAny = (entries: GenerateEntry[], needles: string[]): void => {
  const names = filenames(entries);
  if (needles.some((needle) => names.some((name) => name.includes(needle)))) {
    return;
  }
  throw new Error(
    `codegen missing ${needles.join(" or ")}; got ${names.join(", ")}`,
  );
};

const placeLayered = (
  dir: string,
  entries: GenerateEntry[],
  organizeByFeature: boolean,
): GenerateEntry[] => (organizeByFeature ? entries : nestUnder(dir, entries));

export type ContactsLaneEntries = {
  datasource: GenerateEntry[];
  datasourceValidators: GenerateEntry[];
  datasourceTests: GenerateEntry[];
  datasourceValidatorTests: GenerateEntry[];
  views: GenerateEntry[];
  viewTests: GenerateEntry[];
  viewValidators: GenerateEntry[];
  viewValidatorTests: GenerateEntry[];
  services: GenerateEntry[];
  serviceTests: GenerateEntry[];
  serviceIntegrationTests: GenerateEntry[];
  routes: GenerateEntry[];
  routeTests: GenerateEntry[];
  frontendValidators: GenerateEntry[];
  frontendTypeTests: GenerateEntry[];
  frontendValidatorTests: GenerateEntry[];
  clientBindingLiveTests: GenerateEntry[];
  clientBindingMockTests: GenerateEntry[];
};

export type BootedContactsApp = BootedApp & {
  variant: ContactsVariant;
  settings: Record<string, string>;
  lanes: ContactsLaneEntries;
};

const generateLanes = async (
  sample: ContactsSample,
): Promise<ContactsLaneEntries> => {
  const ctx = {
    reader: fileReader(CONTACTS_FIXTURE_DIR),
    settings: sample.settings,
  };
  const [
    datasource,
    datasourceValidators,
    datasourceTests,
    datasourceValidatorTests,
    views,
    viewTests,
    viewValidators,
    viewValidatorTests,
    services,
    serviceTests,
    serviceIntegrationTests,
    routes,
    routeTests,
    frontendValidators,
    frontendTypeTests,
    frontendValidatorTests,
    clientBindingLiveTests,
    clientBindingMockTests,
  ] = await Promise.all([
    generateDatasourceTypes(ctx),
    generateDatasourceTypeValidators(ctx),
    generateDatasourceTypesTests(ctx),
    generateDatasourceTypeValidatorsTests(ctx),
    generateViewTypes(ctx),
    generateViewTypesTests(ctx),
    generateViewTypeValidators(ctx),
    generateViewTypeValidatorsTests(ctx),
    generateServices(ctx),
    generateServiceTests(ctx),
    generateServiceIntegrationTests(ctx),
    generateRoutes(ctx),
    generateRoutesTests(ctx),
    generateFrontendValidators(ctx),
    generateFrontendTypesTests(ctx),
    generateFrontendValidatorsTests(ctx),
    generateClientBindingsLiveTests(ctx),
    generateClientBindingsMockTests(ctx),
  ]);
  requireNamed(datasource, "contacts_base");
  requireNamed(datasourceValidators, "contacts_base");
  requireNamed(views, "contact");
  requireNamed(viewValidators, "contact");
  requireNamedAny(services, ["contact-import-service", "ContactImportService"]);
  requireNamedAny(services, [
    "legacy-migration-service",
    "LegacyMigrationService",
  ]);
  requireNamed(routes, "contact");
  return {
    datasource,
    datasourceValidators,
    datasourceTests,
    datasourceValidatorTests,
    views,
    viewTests,
    viewValidators,
    viewValidatorTests,
    services,
    serviceTests,
    serviceIntegrationTests,
    routes,
    routeTests,
    frontendValidators,
    frontendTypeTests,
    frontendValidatorTests,
    clientBindingLiveTests,
    clientBindingMockTests,
  };
};

export const bootContactsSample = async (
  variant: ContactsVariant,
  tempPrefix: string,
): Promise<BootedContactsApp> => {
  const sample = await loadContactsSample(variant);
  const ctx = {
    reader: fileReader(CONTACTS_FIXTURE_DIR),
    settings: sample.settings,
  };
  const [
    appEntries,
    frontendEntries,
    typeEntries,
    bindingEntries,
    sqlEntries,
    migrateEntries,
    lanes,
    routesE2eEntries,
  ] = await Promise.all([
    generateBackendApp(ctx),
    generateFrontendApp(ctx),
    generateFrontendTypes(ctx),
    generateClientBindings(ctx),
    generateSql(ctx),
    generateBundledMigrate(
      sample.settings,
      fileReader(CONTACTS_FIXTURE_DIR),
    ),
    generateLanes(sample),
    generateRoutesE2eTest(ctx),
  ]);
  requireNamed(frontendEntries, "frontend/src/app.tsx");
  requireNamed(bindingEntries, "frontend/src/client/fetch/http.ts");
  requireNamed(migrateEntries, "migraters/typescript/package.json");
  requireNamed(migrateEntries, "migraters/typescript/src/bin/migrate-up.ts");
  requireNamed(routesE2eEntries, "__tests__/app.integration.test.ts");

  const byFeature = variant.organizeByFeature;
  const layered = {
    datasource: placeLayered(
      "types/generated/datasource",
      lanes.datasource,
      byFeature,
    ),
    datasourceValidators: placeLayered(
      "types/generated/datasource/validators",
      lanes.datasourceValidators,
      byFeature,
    ),
    datasourceTests: placeLayered(
      "types/generated/datasource",
      lanes.datasourceTests,
      byFeature,
    ),
    datasourceValidatorTests: placeLayered(
      "types/generated/datasource/validators",
      lanes.datasourceValidatorTests,
      byFeature,
    ),
    views: placeLayered("types/generated/views", lanes.views, byFeature),
    viewTests: placeLayered("types/generated/views", lanes.viewTests, byFeature),
    viewValidators: placeLayered(
      "types/generated/views/validators",
      lanes.viewValidators,
      byFeature,
    ),
    viewValidatorTests: placeLayered(
      "types/generated/views/validators",
      lanes.viewValidatorTests,
      byFeature,
    ),
    services: placeLayered("services/generated", lanes.services, byFeature),
    serviceTests: placeLayered(
      "services/generated/__tests__",
      lanes.serviceTests,
      byFeature,
    ),
    serviceIntegrationTests: placeLayered(
      "services/generated/__tests__",
      lanes.serviceIntegrationTests,
      byFeature,
    ),
    routes: placeLayered("routes/generated", lanes.routes, byFeature),
    routeTests: placeLayered(
      "routes/generated/__tests__",
      lanes.routeTests,
      byFeature,
    ),
  };

  await removeE2eTempDirs([tempPrefix]);
  const appDir = await mkdtemp(join(tmpdir(), tempPrefix));
  const entries = [
    ...appEntries,
    ...frontendEntries,
    ...typeEntries,
    ...bindingEntries,
    ...lanes.frontendValidators,
    ...lanes.frontendTypeTests,
    ...lanes.frontendValidatorTests,
    ...lanes.clientBindingLiveTests,
    ...lanes.clientBindingMockTests,
    ...layered.datasource,
    ...layered.datasourceValidators,
    ...layered.datasourceTests,
    ...layered.datasourceValidatorTests,
    ...layered.views,
    ...layered.viewTests,
    ...layered.viewValidators,
    ...layered.viewValidatorTests,
    ...layered.services,
    ...layered.serviceTests,
    ...layered.serviceIntegrationTests,
    ...layered.routes,
    ...layered.routeTests,
    ...routesE2eEntries,
    ...withSqlRoot(sqlEntries),
    ...migrateEntries,
  ];
  if (verboseOutputEnabled()) dumpCodegenEntries(entries);
  await writeGenerateEntries(appDir, entries);
  await writeDeterministicYaml(appDir, sample.yaml);
  if (verboseOutputEnabled()) await dumpFinalFiles(appDir);

  await Promise.all([
    installFrontend(appDir),
    installBuildAndMigrateSqlite(appDir),
  ]);
  const booted = await startGeneratedServer(appDir, {
    ...sqliteAppEnv(appDir),
    DETERMINISTIC_TRACE: "route,service,datasource",
    SRC_ROOT: join(appDir, "dist"),
  });
  await testFrontend(appDir, {
    CLIENT_BINDINGS_BASE_URL: `http://127.0.0.1:${booted.port}`,
  });
  return {
    ...booted,
    variant,
    settings: sample.settings,
    lanes,
  };
};

export const requireAppFile = async (
  appDir: string,
  rel: string,
): Promise<void> => {
  await access(join(appDir, rel));
};

export const viewValidatorPath = (
  entity: string,
  variant: ContactsVariant,
  settings: Record<string, string>,
): string => {
  const laid = createImportGenerator(".", settings).viewValidator(entity);
  return variant.organizeByFeature
    ? laid
    : `types/generated/views/validators/${laid}`;
};

export const datasourceTypePath = (
  entity: string,
  variant: ContactsVariant,
  settings: Record<string, string>,
): string => {
  const laid = createImportGenerator(".", settings).datasource(entity);
  return variant.organizeByFeature
    ? laid
    : `types/generated/datasource/${laid}`;
};

export const customServicePath = (
  name: string,
  module: string,
  variant: ContactsVariant,
  settings: Record<string, string>,
): string => {
  const laid = createImportGenerator(".", settings).serviceCustom(name, module);
  return variant.organizeByFeature
    ? laid
    : posix.normalize(`services/generated/${laid}`);
};

export const dumpContactsTrace = (booted: BootedApp): void => {
  if (!verboseOutputEnabled()) return;
  dumpServerTrace(Buffer.concat(booted.stdoutChunks).toString());
};
