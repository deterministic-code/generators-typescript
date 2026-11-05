import {
  createCasingStrategy,
  type ICasingStrategy,
} from "@deterministic-code/generators-common/casing-strategy";
import { Paths } from "@deterministic-code/generators-common/paths";

export const GENERATOR_LANGUAGE = "typescript";

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const VARIANT_PREFIXES = ["update_", "create_"] as const;

export const jsIdent = (name: string): string =>
  IDENT_RE.test(name) ? name : JSON.stringify(name);

const featureEntity = (entity: string): string => {
  const prefix = VARIANT_PREFIXES.find((p) => entity.startsWith(p));
  return prefix === undefined ? entity : entity.slice(prefix.length);
};

export type PackCasing = ICasingStrategy & {
  entityName: (specName: string) => string
  fileBase: (stem: string) => string
  directory: (entity: string) => string
  filePath: (stem: string) => string
  fieldIdent: (field: string) => string
  serviceClassName: (entity: string) => string
  serviceInterfaceName: (entity: string) => string
  authoredInterfaceName: (name: string) => string
  baseTypeName: (entity: string) => string
  schemaName: (name: string) => string
  validatedTypeName: (name: string) => string
  routerFnName: (entity: string) => string
  hookName: (entity: string, method: string) => string
  finderMethod: (field: string) => string
  clientName: (entity: string) => string
  clientQueryOptionsName: (entity: string) => string
  clientMutationOptionsName: (entity: string) => string
  appFnName: () => string
  appComponentName: () => string
  homeComponentName: () => string
  rootLayoutName: () => string
  appConfigName: () => string
};

/** Language defaults + settings overrides. Layout (by-feature) lives on ImportGenerator. */
export const createCasing = (
  settings: Record<string, string>,
): PackCasing => {
  const casing = createCasingStrategy(GENERATOR_LANGUAGE, settings);
  const paths = new Paths();
  const fileBase = (stem: string): string => casing.convertFileName(stem);
  const entityName = (specName: string): string => casing.convertTypes(paths.typeStem(specName));
  const directory = (entity: string): string =>
    casing.convertDirectories(featureEntity(entity));
  const filePath = (stem: string): string => `${fileBase(stem)}.ts`;
  const convertFields = (text: string): string => casing.convertFields(text);
  const fieldIdent = (field: string): string => jsIdent(convertFields(field));
  return {
    convertFileName: (text: string) => casing.convertFileName(text),
    convertTypes: (text: string) => casing.convertTypes(text),
    convertFields,
    convertDirectories: (text: string) => casing.convertDirectories(text),
    entityName,
    fileBase,
    directory,
    filePath,
    fieldIdent,
    serviceClassName: (entity: string) => casing.convertTypes(`${entity}_service`),
    serviceInterfaceName: (entity: string) =>
      casing.convertTypes(`i_${entity}_service`),
    authoredInterfaceName: (name: string) => casing.convertTypes(`i_${name}`),
    baseTypeName: (entity: string) => casing.convertTypes(`${entity}_base`),
    schemaName: (name: string) =>
      casing.convertTypes(`${paths.typeStem(name)}_schema`),
    validatedTypeName: (name: string) =>
      casing.convertTypes(`${paths.typeStem(name)}_validated`),
    routerFnName: (entity: string) => casing.convertTypes(`${entity}_router`),
    hookName: (entity: string, method: string) =>
      casing.convertTypes(`use_${entity}_${method}`),
    finderMethod: (field: string) => convertFields(`find_by_${field}`),
    clientName: (entity: string) => casing.convertTypes(`${entity}_client`),
    clientQueryOptionsName: (entity: string) =>
      casing.convertTypes(`${entity}_client_query_options`),
    clientMutationOptionsName: (entity: string) =>
      casing.convertTypes(`${entity}_client_mutation_options`),
    appFnName: () => casing.convertTypes("create_backend_app"),
    appComponentName: () => casing.convertTypes("app"),
    homeComponentName: () => casing.convertTypes("home"),
    rootLayoutName: () => casing.convertTypes("root_layout"),
    appConfigName: () => casing.convertTypes("app_config"),
  };
};

export const defaultCasing = (
  settings: Record<string, string>,
): ICasingStrategy => createCasing(settings);
