export {
  createBackendApp,
  type CreateAppOptions,
  type CreateAppContext,
  type CreateAppHook,
  type CreateBackendAppOptions,
  type BeforeHookContext,
  type BeforeHookResult,
  type AfterHookContext,
  type RouteComposeContext,
  type RouteComposer,
} from './createBackendApp';

export { applyEnableMiddleware, parseEnableMiddlewareEnv } from './enableMiddleware';

export {
  connectDatabase,
  type ConnectDatabaseOptions,
  type SupportedBackend,
  type SqliteHandle,
} from './connectDatabase';

export type { DatabaseConnection, DatabaseBackendType } from './database';

export { start, type StartOptions, type StartHandle } from './start';

export {
  parseBackendAppConfig,
  type BackendAppConfig,
  type StaticEntry,
} from './loaders/parseBackendAppConfig';
export { loadBackendAppConfig } from './loaders/loadBackendAppConfig';

export {
  loadSettingsConfig,
  parseSettingsConfig,
  type SettingsConfig,
} from './loaders/loadSettingsConfig';

export { parseGenericRouteSpecs, type GenericRouteSpec } from './loaders/parseRouteSpecs';
export { loadGenericRouteSpecs, loadRoutesYaml } from './loaders/loadRouteSpecs';

export {
  parseCrudRouteSpecs,
  buildBodySchema,
  serviceKeyFor,
  type CrudRouteSpec,
} from './loaders/parseCrudRouteSpecs';
export { loadCrudRouteSpecs } from './loaders/loadCrudRouteSpecs';

export { parseServiceSpecs } from './loaders/parseServiceSpecs';
export { loadServiceSpecs } from './loaders/loadServiceSpecs';

export {
  resolveServices,
  applyClassStaticDependencies,
  lowerFirst,
  type ResolveServicesInputs,
} from './services/resolveServices';

export type { ArgSpec, ServiceSpec, ServiceConstructor } from './services/types';
