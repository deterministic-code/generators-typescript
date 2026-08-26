import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { buildRepoForBackend, PrimaryKeyService, type DatabaseConnection } from '../repositories';
import { createNameMapper, resolveFieldConverters } from '../repositories/createNameMapper';
import type { ITypeFieldConverter, SupportedDatasource } from '../converters/ITypeFieldConverter';
import { getDefaultConverters } from '../converters/registry';
import {
  DataSourceMiddlewareLookup,
  errorHandler,
  MiddlewareLookup,
  ServiceMiddlewareLookup,
  traceRouteErrorMiddleware,
  type DataSourceMiddlewareFactory,
  type MiddlewareDeps,
  type MiddlewareHandler,
  type IServiceMiddleware,
  type RouteMiddlewareFactory,
  type ServiceMiddlewareFactory,
} from '../middleware';
import { discoverServiceMethods, wrapServicesWithTrace } from './services/wrapServicesWithTrace';
import {
  createByFieldRouter,
  createCrudRouter,
  createGenericRouter,
  createReadOnlyRouter,
  mountCombinedRoutes,
  type DatasourceData,
  type GenericResponseFormat,
  type GenericRouterMethod,
  type RoutesData,
} from '../routes';
import type { IEntityService } from '../services/interfaces/IEntityService';
import { EntityService } from '../services/EntityService';
import { LookupEnrichedService, type LookupMapping } from '../services/LookupEnrichedService';
import { EagerChildLoadingService } from '../services/EagerChildLoadingService';
import {
  EagerChildWritingService,
  type EagerWriteChildBinding,
} from '../services/EagerChildWritingService';

import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';

import { pathExists } from '../repositories/pathExists';
import type { ZodSchema } from 'zod';

import { applyEnableMiddleware } from './enableMiddleware';
import { connectDatabase } from './connectDatabase';
import { loadBackendAppConfig } from './loaders/loadBackendAppConfig';
import { loadSettingsConfig, type SettingsConfig } from './loaders/loadSettingsConfig';
import type { BackendAppConfig, MiddlewareEntry } from './loaders/parseBackendAppConfig';
import {
  parseGenericRouteSpecs,
  parseCustomRouteSpecs,
  type CustomRouteSpec,
  type GenericRouteSpec,
} from './loaders/parseRouteSpecs';
import {
  buildBodySchema,
  parseCrudRouteSpecs,
  serviceKeyFor,
  type CrudRouteSpec,
} from './loaders/parseCrudRouteSpecs';
import {
  computeEnrichments,
  enrichmentsFromCrudSpec,
} from './loaders/computeEnrichments';
import {
  computeEagerChildren,
  subtreeFor,
  type EagerChildSpec,
  type EagerLoadGate,
  type EagerLoadTree,
} from './loaders/computeEagerChildren';
import { parseEagerPaths, parseMemberOnlyReadPaths } from './loaders/parseEagerPaths';
import { parseServiceSpecs } from './loaders/parseServiceSpecs';
import {
  applyClassStaticDependencies,
  lowerFirst,
  resolveArg,
  resolveServices,
} from './services/resolveServices';
import type { ServiceConstructor, ServiceSpec } from './services/types';

// Built-in tail handlers — auto-mounted at chain end unless disabled in backend-app.yaml or shadowed by a same-named services.yaml module (precedence: user wins). Stored as raw Express middleware; Express auto-detects 4-arg error handlers by arity.
const BUILT_IN_HANDLERS: Record<string, RequestHandler | ErrorRequestHandler> = {
  NotFoundMiddlewareService: (_req: Request, res: Response, _next: NextFunction) => {
    res.status(404).json({ errors: [{ code: 'NOT_FOUND', message: 'Route not found' }] });
  },
  ErrorHandlerMiddlewareService: errorHandler,
};

export interface CreateAppContext {
  app: Express;
  conn: DatabaseConnection;
  backendAppConfig: BackendAppConfig;
  middlewareLookup: MiddlewareLookup;
  routeSpecs: GenericRouteSpec[];
  crudSpecs: CrudRouteSpec[];
  repos: Record<string, unknown>;
  services: Record<string, unknown>;
  config: Record<string, unknown>;
}

export type CreateAppHook = (ctx: CreateAppContext) => void | Promise<void>;

/**
 * What a generated route composer sees: the fully-composed per-entity CRUD service
 * (enrichment → eager-read → eager-write/OCC stack, the same one the dynamic path
 * mounts) plus the resolved contract docs. `entityService` is the single service a
 * generated router forwards every verb to, so the router stays a thin adapter and all
 * cross-cutting behavior lives in the composed stack. Mirrors the Rust ComposeContext.
 */
export interface RouteComposeContext {
  entityService(entityName: string): IEntityService<any, any>;
  bodySchema(entityName: string, verb: 'create' | 'update'): ZodSchema;
  repos: Record<string, unknown>;
  datasourceData: DatasourceData;
  routesData: RoutesData;
}

/**
 * A generated backend supplies this to route requests through its generated routers
 * (which forward to the composed services above) instead of the runtime's dynamic CRUD
 * synthesis. When set, createBackendApp mounts the returned router and skips its own
 * per-entity CRUD/byField mounting; combined m2m routes stay dynamic. Mirrors the Rust
 * RunConfig.route_composer hook.
 */
export type RouteComposer = (ctx: RouteComposeContext) => import('express').Router;

export interface CreateAppOptions {
  /**
   * Directory containing backend-app.yaml, services.yaml, routes.yaml,
   * types.yaml, and view_types.yaml. Defaults to
   * `<cwd>/deterministic`.
   */
  deterministicRoot?: string;

  /**
   * Directory module paths in services.yaml (`module:`) and routes.yaml
   * (`routeClass:` + `module:`) are resolved against. Defaults to
   * `<deterministicRoot>/../src` so a typical layout
   * (`<project>/deterministic`, `<project>/src`) needs no override.
   */
  srcRoot?: string;

  /**
   * When true, the runtime applies auto-enrichment: lookup-table FKs are
   * replaced by their resolved name on read and accepted by name on write.
   * Falls back to view_types.yaml's `datasource_types.auto_enrich` flag if
   * the file exists; otherwise defaults to false.
   */
  viewTypesAutoEnrich?: boolean;

  backendAppConfig?: BackendAppConfig;
  /**
   * Per-project settings — currently the `pluralize_datatable_names` flag
   * that decides whether the runtime queries `contacts` vs `contact`.
   * When omitted, loaded from `<deterministicRoot>/settings.yaml` if
   * present; missing file or missing flag defaults to `{ pluralizeTableNames: true }`
   * to match the codegen emitter default introduced in PR #416.
   */
  settingsConfig?: SettingsConfig;
  routeSpecs?: GenericRouteSpec[];
  datasourceData?: DatasourceData;

  /**
   * Consumer-supplied converters keyed by the `type_converter` name declared on a
   * field in `datasource_mappings`. A field naming a converter not present here
   * throws at repo build — never a silent fallthrough.
   */
  customConverters?: ReadonlyMap<string, ITypeFieldConverter>;
  routesData?: RoutesData;
  crudSpecs?: CrudRouteSpec[];
  serviceSpecs?: ServiceSpec[];
  viewTypesDoc?: unknown;

  classRegistry?: Record<string, ServiceConstructor>;

  /**
   * Overrides for where a custom service/route's implementation lives on disk,
   * keyed by the original `module:` value in services.yaml/routes.yaml. In
   * `organize_by_feature` layouts the emitted `app.ts` glue populates this from
   * `CodegenLayout` so the shipped contract stays the verbatim, layout-neutral
   * input while the runtime still loads the relocated `features/<entity>/custom/`
   * file. When a `module:` is absent from the map, `loadClass` uses it as-is.
   */
  customModulePaths?: Record<string, string>;
  config?: Record<string, unknown>;

  middlewareLookup?: MiddlewareLookup;
  middlewareDeps?: MiddlewareDeps;
  serviceMiddlewareLookup?: ServiceMiddlewareLookup;
  datasourceMiddlewareLookup?: DataSourceMiddlewareLookup;
  middlewareFactories?: {
    route?: Record<string, RouteMiddlewareFactory>;
    service?: Record<string, ServiceMiddlewareFactory>;
    datasource?: Record<string, DataSourceMiddlewareFactory>;
  };

  /**
   * Names of middleware entries in backend-app.yaml to force-enable at boot,
   * overriding their `enabled: false` setting. The generated server.ts
   * derives this list from the `DETERMINISTIC_TRACE` env var so the
   * verify/battletest pipeline can flip on tier-trace middleware
   * (`traceRoute`, `traceService`, `traceDatasource`) without rewriting
   * the consumer's backend-app.yaml.
   */
  enableMiddleware?: ReadonlyArray<string>;

  /**
   * Build MiddlewareDeps from resolved services. Called after services are
   * constructed but before global middleware and routes are mounted. Use
   * when middleware needs deps that depend on services (e.g. authService,
   * authorizationService). Mutually exclusive in spirit with middlewareDeps:
   * if both are set, the callback wins.
   */
  middlewareDepsFromServices?: (ctx: CreateAppContext) => MiddlewareDeps;

  onBeforeCreateApp?: CreateAppHook;
  onAfterCreateApp?: CreateAppHook;

  /**
   * When set, the generated backend's route composer owns every per-entity CRUD +
   * byField route (forwarding to the composed services). The runtime builds the service
   * stack as usual, mounts the composed router, and skips its own dynamic CRUD/byField
   * synthesis. Combined m2m routes stay dynamic. Unset ⇒ the dynamic path (unchanged).
   */
  routeComposer?: RouteComposer;
}

export interface BeforeHookContext {
  deterministicRoot: string;
  srcRoot: string;
}

export interface BeforeHookResult {
  connection?: DatabaseConnection;
}

export interface AfterHookContext {
  connection: DatabaseConnection;
}

export interface CreateBackendAppOptions extends CreateAppOptions {
  beforeCreateBackendApp?: (ctx: BeforeHookContext) => Promise<BeforeHookResult> | BeforeHookResult;
  afterCreateBackendApp?: (app: Express, ctx: AfterHookContext) => Promise<void> | void;
}

function resolveDeterministicRoot(deterministicRoot?: string): string {
  return deterministicRoot ?? path.resolve(process.cwd(), 'deterministic');
}

function isBareSpecifier(modulePath: string): boolean {
  if (modulePath.startsWith('.') || modulePath.startsWith('/')) return false;
  if (/^[A-Za-z]:[\\/]/.test(modulePath)) return false;
  return true;
}

async function loadClass(
  srcRoot: string,
  modulePath: string,
  exportName: string,
): Promise<ServiceConstructor> {
  let specifier: string;
  if (isBareSpecifier(modulePath)) {
    specifier = modulePath;
  } else {
    const abs = path.resolve(srcRoot, modulePath);
    const candidates = path.extname(abs) ? [abs] : [`${abs}.js`, `${abs}.mjs`, `${abs}.ts`, abs];
    let found: string | undefined;
    for (const p of candidates) {
      if (await pathExists(p)) {
        found = p;
        break;
      }
    }
    if (!found) {
      throw new Error(
        `createBackendApp: module "${modulePath}" not found (looked for ${candidates.join(', ')})`,
      );
    }
    specifier = pathToFileURL(found).href;
  }
  const mod = (await import(specifier)) as Record<string, unknown>;
  const Ctor = mod[exportName];
  if (typeof Ctor !== 'function') {
    throw new Error(
      `createBackendApp: module "${modulePath}" has no exported class named "${exportName}"`,
    );
  }
  return Ctor as ServiceConstructor;
}

// Where custom service/route impls are resolved from: `srcRoot` plus the by-feature `customModulePaths` override map (original `module:` → relocated path) the emitted app.ts supplies.
interface ModuleLoadContext {
  srcRoot: string;
  customModulePaths?: Record<string, string>;
}

async function loadServiceClasses(
  load: ModuleLoadContext,
  specs: ServiceSpec[],
): Promise<Record<string, ServiceConstructor>> {
  const registry: Record<string, ServiceConstructor> = {};
  for (const spec of specs) {
    if (!spec.module) continue;
    const modulePath = load.customModulePaths?.[spec.module] ?? spec.module;
    registry[spec.name] = await loadClass(load.srcRoot, modulePath, spec.name);
  }
  return registry;
}

interface CustomRouteInstance {
  spec: CustomRouteSpec;
  instance: { router(): import('express').Router };
}

async function loadCustomRouteInstances(
  load: ModuleLoadContext,
  specs: CustomRouteSpec[],
  ctx: CreateAppContext,
): Promise<CustomRouteInstance[]> {
  const instances: CustomRouteInstance[] = [];
  for (const spec of specs) {
    const modulePath = load.customModulePaths?.[spec.module] ?? spec.module;
    const Ctor = await loadClass(load.srcRoot, modulePath, spec.routeClass);
    const args = spec.args.map((arg, idx) =>
      resolveArg(spec.routeClass, idx, arg, {
        repos: ctx.repos,
        config: ctx.config,
        built: ctx.services,
        overrides: {},
      }),
    );
    const instance = new (Ctor as unknown as new (...a: unknown[]) => unknown)(...args) as {
      router(): import('express').Router;
    };
    if (typeof instance.router !== 'function') {
      throw new Error(
        `createBackendApp: route class "${spec.routeClass}" (from ${spec.module}) does not implement router(): Router`,
      );
    }
    instances.push({ spec, instance });
  }
  return instances;
}

async function readYaml(yamlPath: string): Promise<unknown> {
  return yaml.load(await readFile(yamlPath, 'utf8'));
}

/** Merge any `includes: - file: <path>` entries into a types.yaml doc at runtime by prepending each included file's `types` (the build-time resolver in scripts/lib does the same). Without this the router builder never sees included entities and their CRUD endpoints 404. */
async function resolveDatasourceFileIncludes(doc: unknown, baseDir: string): Promise<unknown> {
  const includes = (doc as { includes?: unknown } | null)?.includes;
  if (!Array.isArray(includes)) return doc;
  const includedTypes: unknown[] = [];
  for (const entry of includes) {
    const file = (entry as { file?: unknown } | null)?.file;
    if (typeof file !== 'string') continue;
    const merged = (await readYaml(path.resolve(baseDir, file))) as {
      types?: unknown;
    } | null;
    if (Array.isArray(merged?.types)) includedTypes.push(...merged.types);
  }
  if (includedTypes.length === 0) return doc;
  const ownTypes = (doc as { types?: unknown }).types;
  const baseTypes = Array.isArray(ownTypes) ? ownTypes : [];
  return { ...(doc as object), types: [...includedTypes, ...baseTypes] };
}

const DEFAULT_HEALTH_PATH = '/api/health';

function hasDeclaredHealthRoute(
  routeSpecs: ReadonlyArray<{ path: string; method: string }>,
  customRouteSpecs: ReadonlyArray<{ path: string; method: string }>,
  routesDoc: unknown,
): boolean {
  const isHealthGet = (r: { path: string; method: string }): boolean =>
    r.path === DEFAULT_HEALTH_PATH && r.method.toUpperCase() === 'GET';

  if (routeSpecs.some(isHealthGet)) return true;
  if (customRouteSpecs.some(isHealthGet)) return true;

  // Catch soft-skipped entries (service: without serviceMethod:, kept as OpenAPI metadata) so the library default doesn't shadow a path the consumer claims.
  const entries = ((routesDoc as { routes?: unknown[] } | null)?.routes ?? []) as unknown[];
  for (const entry of entries) {
    // why null/string skip: bare-string and `{name: null}` byField shorthand have no path/method to inspect — they could never claim /api/health regardless.
    if (entry === null || typeof entry !== 'object') continue;
    for (const fields of Object.values(entry)) {
      if (fields === null || typeof fields !== 'object') continue;
      const f = fields as { path?: unknown; method?: unknown };
      if (f.path !== DEFAULT_HEALTH_PATH) continue;
      const method = f.method === undefined ? 'GET' : String(f.method).toUpperCase();
      if (method === 'GET') return true;
    }
  }
  return false;
}

function iterateMiddlewareForTier<T>(
  entries: MiddlewareEntry[],
  type: 'route' | 'service' | 'datasource',
  resolve: (name: string) => T,
): T[] {
  return entries.filter((e) => e.type === type && e.enabled !== false).map((e) => resolve(e.name));
}

const CRUD_SERVICE_METHODS = [
  'query',
  'findAll',
  'find',
  'findById',
  'findBy',
  'create',
  'update',
  'patch',
  'remove',
  'delete',
  'updateBy',
  'deleteBy',
];

function wrapCtxServices(
  services: Record<string, unknown>,
  middlewares: ReadonlyArray<IServiceMiddleware>,
): void {
  if (middlewares.length === 0) return;
  for (const key of Object.keys(services)) {
    const target = services[key];
    if (!target || typeof target !== 'object') continue;
    const label = (target as { constructor?: { name?: string } }).constructor?.name || key;
    services[key] = wrapServicesWithTrace(
      target as object,
      label,
      middlewares,
      discoverServiceMethods(target as object),
    );
  }
}

function wrapCrudServiceMap(
  serviceMap: Map<string, IEntityService<any, any>>,
  middlewares: ReadonlyArray<IServiceMiddleware>,
): void {
  if (middlewares.length === 0) return;
  for (const [entityName, svc] of serviceMap.entries()) {
    serviceMap.set(
      entityName,
      wrapServicesWithTrace(
        svc as object,
        entityName,
        middlewares,
        CRUD_SERVICE_METHODS,
      ) as IEntityService<any, any>,
    );
  }
}

export function createBackendApp(options: CreateBackendAppOptions): Promise<Express>;
export function createBackendApp(
  conn: DatabaseConnection,
  options?: CreateAppOptions,
): Promise<Express>;
export function createBackendApp(
  first: DatabaseConnection | CreateBackendAppOptions,
  second?: CreateAppOptions,
): Promise<Express> {
  if (isDatabaseConnection(first)) {
    return createBackendAppCore(first, second ?? {});
  }
  return createBackendAppWithHooks(first);
}

function isDatabaseConnection(arg: unknown): arg is DatabaseConnection {
  return (
    typeof arg === 'object' &&
    arg !== null &&
    typeof (arg as { close?: unknown }).close === 'function' &&
    typeof (arg as { type?: unknown }).type === 'string'
  );
}

function datasourceDirectiveOf(doc: unknown): { auto_enrich?: boolean } | null {
  const includes = (doc as { includes?: unknown } | null)?.includes;
  if (!Array.isArray(includes)) return null;
  const entry = includes.find(
    (e): e is { datasource_types?: { auto_enrich?: boolean } } =>
      typeof e === 'object' && e !== null && 'datasource_types' in e,
  );
  return entry?.datasource_types ?? null;
}

async function createBackendAppWithHooks(options: CreateBackendAppOptions): Promise<Express> {
  const deterministicRoot = resolveDeterministicRoot(options.deterministicRoot);
  const srcRoot = options.srcRoot ?? path.resolve(deterministicRoot, '..', 'src');
  const beforeResult =
    (await options.beforeCreateBackendApp?.({
      deterministicRoot,
      srcRoot,
    })) ?? {};
  const connection = beforeResult.connection ?? (await connectDatabase({ backend: 'memory' }));
  const app = await createBackendAppCore(connection, options);
  await options.afterCreateBackendApp?.(app, { connection });
  return app;
}

// solid-s-allow: orchestration facade assembling one Express app from the resolved contract (inputs → repos → services → routes); state lives on `this` across phase methods and the build order matters. Its fan-out is the wiring itself, not multiple responsibilities — it replaces a single 225-line function with the identical dependency set, and each phase stays within the function-metric budgets.
class BackendAppBuilder {
  private readonly app: Express = express();
  private srcRoot!: string;
  private at!: (file: string) => string;
  private backendAppConfig!: BackendAppConfig;
  private settingsConfig!: SettingsConfig;
  private routesDoc: unknown;
  private datasourceDoc: unknown;
  private datasourceOverlaysDoc: unknown = null;
  private viewTypesDoc: unknown;
  private autoEnrich = false;
  private eagerPathTrees!: ReturnType<typeof parseEagerPaths>;
  private memberOnlyReadPaths!: ReturnType<typeof parseMemberOnlyReadPaths>;
  private routeSpecs!: GenericRouteSpec[];
  private customRouteSpecs!: CustomRouteSpec[];
  private crudSpecs!: CrudRouteSpec[];
  private datasourceData!: DatasourceData;
  private routesData!: RoutesData;
  private serviceSpecs!: ServiceSpec[];
  private declaredOrder!: MiddlewareEntry[];
  private deferMiddlewareLookup = false;
  private middlewareLookup: MiddlewareLookup | undefined;
  private rawRepos: Record<string, unknown> = {};
  private repos: Record<string, unknown> = {};
  private serviceMiddlewares: IServiceMiddleware[] = [];
  private ctx!: CreateAppContext;

  constructor(
    private readonly conn: DatabaseConnection,
    private readonly options: CreateAppOptions,
  ) {}

  async build(): Promise<Express> {
    await this.resolveConfigAndDocs();
    await this.resolveSpecs();
    this.wireDatasourceTier();
    this.buildRepos();
    this.buildContext();
    await this.options.onBeforeCreateApp?.(this.ctx);
    await this.resolveServiceTier();
    await this.mountRoutes();
    this.mountCrudRoutes();
    await this.finalize();
    return this.app;
  }

  private async resolveConfigAndDocs(): Promise<void> {
    const { options } = this;
    const root = resolveDeterministicRoot(options.deterministicRoot);
    this.srcRoot = options.srcRoot ?? path.resolve(root, '..', 'src');
    this.at = (file: string): string => path.resolve(root, file);
    this.backendAppConfig =
      options.backendAppConfig ?? (await loadBackendAppConfig(this.at('backend-app.yaml')));
    this.settingsConfig =
      options.settingsConfig ?? (await loadSettingsConfig(this.at('settings.yaml')));
    applyEnableMiddleware(this.backendAppConfig.middleware, options.enableMiddleware ?? []);
    const needsRoutesDoc = !options.routeSpecs || !options.routesData || !options.crudSpecs;
    this.routesDoc =
      options.routesData ?? (needsRoutesDoc ? await readYaml(this.at('routes.yaml')) : null);
    const needsDatasourceDoc = !options.datasourceData || !options.crudSpecs;
    this.datasourceDoc = needsDatasourceDoc
      ? await resolveDatasourceFileIncludes(await readYaml(this.at('types.yaml')), root)
      : null;
    const datasourceOverlaysPath = this.at('datasource.yaml');
    this.datasourceOverlaysDoc =
      options.datasourceData !== undefined
        ? null
        : (await pathExists(datasourceOverlaysPath))
          ? await readYaml(datasourceOverlaysPath)
          : null;
    const viewTypesPath = this.at('view_types.yaml');
    this.viewTypesDoc =
      options.viewTypesDoc !== undefined
        ? options.viewTypesDoc
        : options.viewTypesAutoEnrich !== undefined
          ? null
          : (await pathExists(viewTypesPath))
            ? await readYaml(viewTypesPath)
            : null;
    this.autoEnrich =
      options.viewTypesAutoEnrich ?? Boolean(datasourceDirectiveOf(this.viewTypesDoc)?.auto_enrich);
  }

  private async resolveSpecs(): Promise<void> {
    const { options } = this;
    this.eagerPathTrees = parseEagerPaths(this.routesDoc as Parameters<typeof parseEagerPaths>[0]);
    this.memberOnlyReadPaths = parseMemberOnlyReadPaths(
      this.routesDoc as Parameters<typeof parseMemberOnlyReadPaths>[0],
    );
    this.routeSpecs = options.routeSpecs ?? parseGenericRouteSpecs(this.routesDoc);
    this.customRouteSpecs = parseCustomRouteSpecs(this.routesDoc);
    this.crudSpecs =
      options.crudSpecs ??
      parseCrudRouteSpecs(this.datasourceDoc, this.routesDoc, {
        viewTypesDoc: this.viewTypesDoc,
        overlaysDoc: this.datasourceOverlaysDoc,
      });
    this.datasourceData = options.datasourceData ?? (this.datasourceDoc as DatasourceData);
    this.routesData = options.routesData ?? (this.routesDoc as RoutesData);
    this.serviceSpecs =
      options.serviceSpecs ?? parseServiceSpecs(await readYaml(this.at('services.yaml')));
    this.declaredOrder = this.backendAppConfig.middleware;
    this.deferMiddlewareLookup = !!options.middlewareDepsFromServices;
    this.middlewareLookup =
      options.middlewareLookup ??
      (this.deferMiddlewareLookup
        ? undefined
        : new MiddlewareLookup(
            options.middlewareDeps ?? {},
            options.middlewareFactories?.route ?? {},
          ));
  }

  private wireDatasourceTier(): void {
    const { app, options } = this;
    for (const entry of this.backendAppConfig.statics ?? []) {
      app.use(entry.path, express.static(path.resolve(entry.dir)));
    }
    const datasourceLookup =
      options.datasourceMiddlewareLookup ??
      new DataSourceMiddlewareLookup(
        options.middlewareDeps ?? {},
        options.middlewareFactories?.datasource ?? {},
      );
    this.conn.middlewares = iterateMiddlewareForTier(this.declaredOrder, 'datasource', (name) =>
      datasourceLookup.get(name),
    );
  }

  private buildRepos(): void {
    const nameMapper = createNameMapper(
      this.datasourceOverlaysDoc ?? this.datasourceData,
      this.settingsConfig.pluralizeTableNames,
    );
    const converters = this.convertersForConnection();
    const primaryKeys = new PrimaryKeyService(this.crudSpecs);
    for (const spec of this.crudSpecs) {
      const mappedTableName = nameMapper.tableFor(spec.entityName);
      const repo = buildRepoForBackend(this.conn, mappedTableName, {
        hasStandardColumns: !spec.readonly,
        entityName: spec.entityName,
        primaryKeys,
        withUuidColumn:
          spec.primaryKeyIdType !== 'uuid' &&
          Boolean(spec.columnTypes && 'uuid' in spec.columnTypes),
        columnTypes: spec.columnTypes ?? {},
        fieldMappings: nameMapper.fieldsFor(spec.entityName),
        ...(converters && { converters }),
        fieldConverters: resolveFieldConverters(
          nameMapper.convertersFor(spec.entityName),
          this.options.customConverters,
          spec.entityName,
        ),
      });
      this.rawRepos[serviceKeyFor(spec.entityName)] = repo;
      this.repos[serviceKeyFor(spec.entityName)] = new EntityService(
        repo as unknown as ConstructorParameters<typeof EntityService>[0],
      );
    }
  }

  // memory/sqlserver/oracle repos don't consume a converter map — omit so their behavior is unchanged.
  private convertersForConnection(): ReadonlyMap<string, ITypeFieldConverter> | undefined {
    const dialect = this.conn.type;
    if (dialect !== 'sqlite' && dialect !== 'mysql' && dialect !== 'postgres') return undefined;
    return getDefaultConverters(dialect satisfies SupportedDatasource, 'typescript');
  }

  private buildContext(): void {
    this.ctx = {
      app: this.app,
      conn: this.conn,
      backendAppConfig: this.backendAppConfig,
      middlewareLookup: this.middlewareLookup ?? new MiddlewareLookup({}),
      routeSpecs: this.routeSpecs,
      crudSpecs: this.crudSpecs,
      repos: this.repos,
      services: {},
      config: this.options.config ?? {},
    };
  }

  private async resolveServiceTier(): Promise<void> {
    const { options, ctx } = this;
    const moduleClassRegistry = await loadServiceClasses(
      { srcRoot: this.srcRoot, customModulePaths: options.customModulePaths },
      this.serviceSpecs,
    );
    const classRegistry: Record<string, ServiceConstructor> = {
      ...moduleClassRegistry,
      ...(options.classRegistry ?? {}),
    };
    const mergedSpecs = applyClassStaticDependencies(this.serviceSpecs, classRegistry);
    const services = resolveServices({
      specs: mergedSpecs,
      classRegistry,
      repos: ctx.repos,
      config: ctx.config,
    });
    Object.assign(ctx.services, services);
    const serviceLookup =
      options.serviceMiddlewareLookup ??
      new ServiceMiddlewareLookup(
        options.middlewareDeps ?? {},
        options.middlewareFactories?.service ?? {},
      );
    this.serviceMiddlewares = iterateMiddlewareForTier(this.declaredOrder, 'service', (name) =>
      serviceLookup.get(name),
    );
    wrapCtxServices(ctx.services, this.serviceMiddlewares);
    if (this.deferMiddlewareLookup) {
      const deps = options.middlewareDepsFromServices!(ctx);
      this.middlewareLookup = new MiddlewareLookup(deps, options.middlewareFactories?.route ?? {});
      ctx.middlewareLookup = this.middlewareLookup;
    }
  }

  private async mountRoutes(): Promise<void> {
    const { app, ctx } = this;
    for (const entry of this.declaredOrder) {
      if (!entry.enabled) continue;
      // datasource/service entries are wired in their own tiers above; only app/route mount as Express handlers
      if (entry.type === 'datasource' || entry.type === 'service') continue;
      const handler = this.middlewareLookup!.get(entry.name);
      app.use(applyRouteGate(handler, entry));
    }
    for (const route of this.routeSpecs) {
      mountGenericRoute(app, route, ctx.services);
    }
    const customRouteInstances = await loadCustomRouteInstances(
      { srcRoot: this.srcRoot, customModulePaths: this.options.customModulePaths },
      this.customRouteSpecs,
      ctx,
    );
    for (const { spec, instance } of customRouteInstances) {
      app.use(spec.path, instance.router());
    }
  }

  private mountCrudRoutes(): void {
    const { app, ctx } = this;
    const enrichedReadServices = buildEnrichedReadServices(
      this.crudSpecs,
      ctx.repos,
      this.datasourceData,
      this.autoEnrich,
    );
    const fullReadServices = buildFullReadServices({
      crudSpecs: this.crudSpecs,
      repos: ctx.repos,
      enrichedReadServices,
      eagerPathTrees: this.eagerPathTrees,
      datasourceDoc: this.datasourceData,
      viewTypesDoc: this.viewTypesDoc,
      memberOnlyReadPaths: this.memberOnlyReadPaths,
    });
    const fullWriteServices = buildFullWriteServices(
      this.crudSpecs,
      { rawRepos: this.rawRepos, fullReadServices, enrichedReadServices },
      this.conn,
    );
    wrapCrudServiceMap(fullReadServices, this.serviceMiddlewares);
    wrapCrudServiceMap(fullWriteServices, this.serviceMiddlewares);
    this.mountEntityCrudRoutes(fullReadServices, fullWriteServices);
    const crudSpecsByEntity = new Map(this.crudSpecs.map((s) => [s.entityName, s]));
    const specFor = (typeName: string) => {
      const spec = crudSpecsByEntity.get(typeName);
      if (!spec) {
        throw new Error(`mountCombinedRoutes: no crud spec for "${typeName}"`);
      }
      return spec;
    };
    mountCombinedRoutes(app, {
      repos: ctx.repos as unknown as Record<string, IEntityService<any, any>>,
      fullReadServices,
      datasourceData: this.datasourceData,
      routesData: this.routesData,
      // Nested POST injects the parent FK; create must drop stamp columns (uuid/created/updated)
      // the way top-level CRUD does. The old update schema required those and 400'd `{ line1, city }`.
      buildCreateSchema: (typeName) => buildBodySchema(specFor(typeName), 'create'),
      buildUpdateSchema: (typeName) => buildBodySchema(specFor(typeName), 'update').partial(),
    });
  }

  /** Composer set ⇒ mount the generated router that forwards to the composed entityService (write stack over the enriched+eager read stack); else the dynamic per-spec CRUD/byField mounting. */
  private mountEntityCrudRoutes(
    fullReadServices: Map<string, IEntityService<any, any>>,
    fullWriteServices: Map<string, IEntityService<any, any>>,
  ): void {
    const { app, ctx } = this;
    const composer = this.options.routeComposer;
    if (composer) {
      const entityService = (name: string): IEntityService<any, any> =>
        fullWriteServices.get(name) ??
        fullReadServices.get(name) ??
        (ctx.repos[serviceKeyFor(name)] as IEntityService<any, any>);
      const crudSpecsByEntity = new Map(this.crudSpecs.map((s) => [s.entityName, s]));
      // The generated router validates bodies with the same buildBodySchema the dynamic path uses (full create, partial update) so eager-write children round-trip and nullable fields stay optional.
      const bodySchema = (name: string, verb: 'create' | 'update'): ZodSchema => {
        const spec = crudSpecsByEntity.get(name);
        if (!spec) throw new Error(`routeComposer: no crud spec for "${name}"`);
        const schema = buildBodySchema(spec, verb);
        return verb === 'update' ? schema.partial() : schema;
      };
      app.use(
        composer({
          entityService,
          bodySchema,
          repos: ctx.repos,
          datasourceData: this.datasourceData,
          routesData: this.routesData,
        }),
      );
      return;
    }
    for (const spec of this.crudSpecs) {
      // why: byField mounts first so `/<field>/:value` wins over CRUD `/:id`
      if (spec.byFields?.length) {
        mountByFieldRoutes(app, spec, ctx.repos, fullWriteServices);
      }
      if (!spec.nestedOnly) {
        mountCrudRouter(app, spec, {
          repos: ctx.repos,
          fullWriteServices,
          useOptimisticConcurrency: usesOptimisticConcurrency(
            spec,
            this.settingsConfig,
          ),
        });
      }
    }
  }

  private async finalize(): Promise<void> {
    const { app, ctx, options } = this;
    await options.onAfterCreateApp?.(ctx);
    if (!hasDeclaredHealthRoute(this.routeSpecs, this.customRouteSpecs, this.routesDoc)) {
      app.get('/api/health', (_req, res) => {
        res.status(200).json({ status: 'ok' });
      });
    }
    const traceRouteEntry = this.declaredOrder.find((e) => e.name === 'traceRoute');
    if (traceRouteEntry?.enabled) {
      app.use(traceRouteErrorMiddleware);
    }
    this.mountDeclaredHandlers();
  }

  private mountDeclaredHandlers(): void {
    const { app, ctx } = this;
    for (const entry of this.backendAppConfig.handlers) {
      if (!entry.enabled) continue;
      const instance = ctx.services[lowerFirst(entry.name)];
      if (!instance) {
        const builtIn = BUILT_IN_HANDLERS[entry.name];
        if (builtIn) {
          app.use(builtIn);
          continue;
        }
        throw new Error(`backend-app.yaml: handler "${entry.name}" is not in resolved services`);
      }
      const fn = (instance as { handle?: unknown }).handle;
      if (typeof fn !== 'function') {
        throw new Error(`backend-app.yaml: ${entry.name}.handle is not a function`);
      }
      app.use(fn as RequestHandler | ErrorRequestHandler);
    }
  }
}

async function createBackendAppCore(
  conn: DatabaseConnection,
  options: CreateAppOptions,
): Promise<Express> {
  return new BackendAppBuilder(conn, options).build();
}

function mountGenericRoute(
  app: Express,
  route: GenericRouteSpec,
  services: Record<string, unknown>,
): void {
  const instance = services[lowerFirst(route.service)];
  if (!instance) {
    throw new Error(
      `routes.yaml: service "${route.service}" for ${route.method} ${route.path} is not in resolved services`,
    );
  }
  const fn = (instance as Record<string, unknown>)[route.serviceMethod];
  if (typeof fn !== 'function') {
    throw new Error(
      `routes.yaml: ${route.service}.${route.serviceMethod} (for ${route.method} ${route.path}) is not a function`,
    );
  }

  const handlerCall = () => (fn as (...args: unknown[]) => Promise<unknown>).call(instance);

  const buildRouter = (mountPath: string) =>
    createGenericRouter({
      method: route.method.toLowerCase() as GenericRouterMethod,
      path: toExpressPath(mountPath),
      handler: handlerCall,
      responseFormat: route.responseFormat as GenericResponseFormat | undefined,
      statusCode: route.statusCode,
    });

  for (const mountPath of [route.path, ...(route.aliases ?? [])]) {
    app.use(buildRouter(mountPath));
  }
}

// Convert OpenAPI-style {param} → Express-style :param so routes.yaml path-params mount correctly.
function toExpressPath(p: string): string {
  return p.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ':$1');
}

function matchesPrefix(reqPath: string, prefix: string): boolean {
  return reqPath === prefix || reqPath.startsWith(prefix + '/');
}

function applyRouteGate(handler: MiddlewareHandler, entry: MiddlewareEntry): MiddlewareHandler {
  if (!entry.apply_routes && !entry.deny_routes) return handler;
  const wrapped = handler as RequestHandler;
  return (req: Request, res: Response, next: NextFunction) => {
    if (entry.apply_routes && !entry.apply_routes.some((p) => matchesPrefix(req.path, p))) {
      return next();
    }
    if (entry.deny_routes && entry.deny_routes.some((p) => matchesPrefix(req.path, p))) {
      return next();
    }
    return wrapped(req, res, next);
  };
}

function buildEnrichedReadServices(
  crudSpecs: CrudRouteSpec[],
  repos: Record<string, unknown>,
  datasourceDoc: unknown,
  autoEnrich: boolean,
): Map<string, IEntityService<any, any>> {
  const out = new Map<string, IEntityService<any, any>>();
  for (const spec of crudSpecs) {
    const baseService = repos[serviceKeyFor(spec.entityName)] as
      | IEntityService<any, any>
      | undefined;
    if (!baseService) continue;
    const enrichments =
      (spec.enrichmentColumns?.length ?? 0) > 0
        ? enrichmentsFromCrudSpec(spec)
        : computeEnrichments(
            spec.entityName,
            datasourceDoc as Parameters<typeof computeEnrichments>[1],
          );
    const mappings: LookupMapping[] = [];
    for (const e of enrichments) {
      const lookupService = repos[serviceKeyFor(e.targetTable)];
      if (!lookupService) continue;
      mappings.push({
        fkField: e.fkColumn,
        nameField: e.newField,
        replaceFk: autoEnrich || spec.replaceLookupFks === true,
        lookupService: lookupService as LookupMapping['lookupService'],
      });
    }
    out.set(
      spec.entityName,
      mappings.length === 0 ? baseService : new LookupEnrichedService(baseService, mappings),
    );
  }
  return out;
}

type EagerServiceMap = Map<string, IEntityService<any, any>>;

interface ChildServiceResolver {
  repos: Record<string, unknown>;
  wrap: (entityName: string, gate: EagerLoadGate) => IEntityService<any, any> | undefined;
}

function markMemberOnly(
  children: EagerChildSpec[],
  entityName: string,
  memberOnlyReadPaths: ReadonlySet<string>,
): void {
  for (const child of children) {
    if (memberOnlyReadPaths.has(`${entityName}.${child.fieldName}`)) child.memberOnly = true;
  }
}

function collectEagerChildServices(
  eagerChildren: EagerChildSpec[],
  gate: EagerLoadGate,
  resolver: ChildServiceResolver,
): {
  childServiceMap: EagerServiceMap;
  joinServiceMap: EagerServiceMap;
  rawChildServiceMap: EagerServiceMap;
} {
  const { repos, wrap } = resolver;
  const childServiceMap: EagerServiceMap = new Map();
  const joinServiceMap: EagerServiceMap = new Map();
  const rawChildServiceMap: EagerServiceMap = new Map();
  for (const child of eagerChildren) {
    const childService = wrap(child.childTable, subtreeFor(gate, child.fieldName));
    if (childService) childServiceMap.set(child.childTable, childService);
    // why raw-repo alongside enriched: attachChildrenBatched groups by FK (application_id), but LookupEnrichedService(replaceFk=true) strips it — raw repo keeps FK for grouping; enriched service then re-queried by id for the per-parent eager-load attach.
    const rawRepo = repos[serviceKeyFor(child.childTable)];
    if (rawRepo)
      rawChildServiceMap.set(child.childTable, rawRepo as IEntityService<any, any>);
    if (child.joinTable) {
      const joinService = repos[serviceKeyFor(child.joinTable)];
      if (joinService)
        joinServiceMap.set(child.joinTable, joinService as IEntityService<any, any>);
    }
  }
  return { childServiceMap, joinServiceMap, rawChildServiceMap };
}

interface FullReadServicesArgs {
  crudSpecs: CrudRouteSpec[];
  repos: Record<string, unknown>;
  enrichedReadServices: EagerServiceMap;
  eagerPathTrees: Map<string, EagerLoadTree>;
  datasourceDoc: unknown;
  viewTypesDoc: unknown;
  memberOnlyReadPaths: ReadonlySet<string>;
}

/** Each table's eager-write child field names (keyed by the parent table at every nesting level), so a write-embed child can be added to that table's eager-read set. */
function buildEagerWriteFieldMap(crudSpecs: CrudRouteSpec[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const walk = (
    parentTable: string,
    children: import('./loaders/parseCrudRouteSpecs').EagerWriteChildSpec[] | undefined,
  ): void => {
    if (!children) return;
    for (const child of children) {
      const fields = map.get(parentTable) ?? new Set<string>();
      fields.add(child.fieldName);
      map.set(parentTable, fields);
      walk(child.childTable, child.children);
    }
  };
  for (const spec of crudSpecs) walk(spec.entityName, spec.eagerWriteChildren);
  return map;
}

function gateIncludesField(gate: EagerLoadGate, fieldName: string): boolean {
  if (gate === '*') return true;
  if (gate instanceof Map) return gate.has(fieldName);
  return false;
}

/** Union the eager-write field names into the eager-read gate so a write-embed child eager-loads even when eager_path doesn't list it. */
function mergeWriteFieldsIntoGate(
  gate: EagerLoadGate,
  writeFields: Set<string> | undefined,
): EagerLoadGate {
  if (!writeFields || writeFields.size === 0) return gate;
  if (gate === '*') return gate;
  const merged: EagerLoadTree = gate instanceof Map ? new Map(gate) : new Map();
  for (const field of writeFields) {
    if (!merged.has(field)) merged.set(field, new Map());
  }
  return merged;
}

/** A child pulled into the read set purely because it's eager-written (absent from eager_path) attaches on member reads only, never on the collection list. */
function markWriteOnlyMemberOnly(
  children: EagerChildSpec[],
  gate: EagerLoadGate,
  writeFields: Set<string> | undefined,
): void {
  if (!writeFields) return;
  for (const child of children) {
    if (writeFields.has(child.fieldName) && !gateIncludesField(gate, child.fieldName)) {
      child.memberOnly = true;
    }
  }
}

function buildFullReadServices(args: FullReadServicesArgs): EagerServiceMap {
  const { crudSpecs, repos, enrichedReadServices, eagerPathTrees } = args;
  const { datasourceDoc, viewTypesDoc, memberOnlyReadPaths } = args;
  const out: EagerServiceMap = new Map();
  const inProgress = new Set<string>();
  const eagerWriteFields = buildEagerWriteFieldMap(crudSpecs);

  const baseFor = (entityName: string): IEntityService<any, any> | undefined =>
    enrichedReadServices.get(entityName) ??
    (repos[serviceKeyFor(entityName)] as IEntityService<any, any> | undefined);

  const wrap = (
    entityName: string,
    gate: EagerLoadGate,
  ): IEntityService<any, any> | undefined => {
    const base = baseFor(entityName);
    if (!base) return undefined;
    if (inProgress.has(entityName)) return base;

    // Eager-write ⟹ eager-read: a write-embed child must round-trip on a member read, so its field joins the read gate even when eager_path omits it.
    const writeFields = eagerWriteFields.get(entityName);
    const readGate = mergeWriteFieldsIntoGate(gate, writeFields);

    const eagerChildren = computeEagerChildren(
      entityName,
      viewTypesDoc as Parameters<typeof computeEagerChildren>[1],
      readGate,
      datasourceDoc as Parameters<typeof computeEagerChildren>[3],
    );
    if (eagerChildren.length === 0) return base;
    markMemberOnly(eagerChildren, entityName, memberOnlyReadPaths);
    markWriteOnlyMemberOnly(eagerChildren, gate, writeFields);

    inProgress.add(entityName);
    const { childServiceMap, joinServiceMap, rawChildServiceMap } = collectEagerChildServices(
      eagerChildren,
      readGate,
      { repos, wrap },
    );
    inProgress.delete(entityName);

    if (childServiceMap.size === 0) return base;
    return new EagerChildLoadingService(
      base,
      eagerChildren,
      childServiceMap,
      joinServiceMap,
      rawChildServiceMap,
    );
  };

  for (const spec of crudSpecs) {
    const service = wrap(spec.entityName, eagerPathTrees.get(spec.entityName));
    if (service) out.set(spec.entityName, service);
  }
  return out;
}

// Every backend repository (SQL dialects + in-memory) rebuilds itself on a transaction-scoped datasource via `cloneOnto`, preserving its id_type / primary key / converters — so this is dialect-agnostic.
function withTxnRepo(repo: any, txn: any): any {
  return repo.cloneOnto(txn);
}

function buildEagerWriteBindings(
  childSpecs: import('./loaders/parseCrudRouteSpecs').EagerWriteChildSpec[] | undefined,
  rawRepos: Record<string, unknown>,
  fullReadServices: Map<string, IEntityService<any, any>>,
  enrichedReadServices: Map<string, IEntityService<any, any>>,
  withTxnRepoFn: (repo: any, txn: any) => any,
): EagerWriteChildBinding[] {
  if (!childSpecs) return [];
  const bindings: EagerWriteChildBinding[] = [];
  for (const childSpec of childSpecs) {
    const childService =
      fullReadServices.get(childSpec.childTable) ?? enrichedReadServices.get(childSpec.childTable);
    const childRepo = rawRepos[serviceKeyFor(childSpec.childTable)] as any;
    if (!childService || !childRepo) continue;

    const nested = buildEagerWriteBindings(
      childSpec.children,
      rawRepos,
      fullReadServices,
      enrichedReadServices,
      withTxnRepoFn,
    );

    if (childSpec.kind === 'm2m') {
      if (!childSpec.junctionTable || !childSpec.parentFkColumn || !childSpec.targetFkColumn) {
        continue;
      }
      const junctionRepo = rawRepos[serviceKeyFor(childSpec.junctionTable)] as any;
      if (!junctionRepo) continue;
      bindings.push({
        kind: 'm2m',
        fieldName: childSpec.fieldName,
        childTable: childSpec.childTable,
        junctionTable: childSpec.junctionTable,
        parentFkColumn: childSpec.parentFkColumn,
        targetFkColumn: childSpec.targetFkColumn,
        service: childService,
        repository: childRepo,
        junctionRepository: junctionRepo,
        withTxnRepoFn,
        ...(nested.length > 0 && { children: nested }),
        ...(childSpec.isArray === false && { isArray: false }),
      });
      continue;
    }

    if (!childSpec.fkColumn) continue;
    bindings.push({
      kind: 'direct-fk',
      fieldName: childSpec.fieldName,
      childTable: childSpec.childTable,
      fkColumn: childSpec.fkColumn,
      service: childService,
      repository: childRepo,
      withTxnRepoFn,
      ...(nested.length > 0 && { children: nested }),
      ...(childSpec.isArray === false && { isArray: false }),
    });
  }
  return bindings;
}

interface WriteServiceContext {
  rawRepos: Record<string, unknown>;
  fullReadServices: Map<string, IEntityService<any, any>>;
  enrichedReadServices: Map<string, IEntityService<any, any>>;
}

interface WriteServiceDeps extends WriteServiceContext {
  datasource: any;
  withTxnRepoFn: ((repo: any, txn: any) => any) | null;
}

// The service that handles writes for one entity: an EagerChildWritingService when the entity has resolvable eager-write children, otherwise its plain read service (null → skip the entity).
function writeServiceForSpec(
  spec: CrudRouteSpec,
  deps: WriteServiceDeps,
): IEntityService<any, any> | null {
  const readService =
    deps.fullReadServices.get(spec.entityName) ?? deps.enrichedReadServices.get(spec.entityName);
  if (!spec.eagerWriteChildren || spec.eagerWriteChildren.length === 0) return readService ?? null;
  if (!deps.withTxnRepoFn || !readService) return readService ?? null;

  const parentRepo = deps.rawRepos[serviceKeyFor(spec.entityName)] as any;
  if (!parentRepo) return readService;

  const childBindings = buildEagerWriteBindings(
    spec.eagerWriteChildren,
    deps.rawRepos,
    deps.fullReadServices,
    deps.enrichedReadServices,
    deps.withTxnRepoFn,
  );
  if (childBindings.length === 0) return readService;

  return new EagerChildWritingService({
    base: readService,
    datasource: deps.datasource,
    parentRepository: parentRepo,
    parentWithTxnRepoFn: deps.withTxnRepoFn,
    children: childBindings,
  });
}

function buildFullWriteServices(
  crudSpecs: CrudRouteSpec[],
  context: WriteServiceContext,
  conn: DatabaseConnection,
): Map<string, IEntityService<any, any>> {
  const hasEagerWrite = crudSpecs.some(
    (s) => s.eagerWriteChildren && s.eagerWriteChildren.length > 0,
  );
  const deps: WriteServiceDeps = {
    ...context,
    datasource: conn.datasource as any,
    withTxnRepoFn: hasEagerWrite ? withTxnRepo : null,
  };

  const out = new Map<string, IEntityService<any, any>>();
  for (const spec of crudSpecs) {
    const service = writeServiceForSpec(spec, deps);
    if (service) out.set(spec.entityName, service);
  }
  return out;
}

function mountByFieldRoutes(
  app: Express,
  spec: CrudRouteSpec,
  repos: Record<string, unknown>,
  fullWriteServices: Map<string, IEntityService<any, any>>,
): void {
  const serviceKey = serviceKeyFor(spec.entityName);
  if (!repos[serviceKey]) {
    throw new Error(
      `createBackendApp: no repository found for ${serviceKey} (entity "${spec.entityName}")`,
    );
  }

  const service =
    fullWriteServices.get(spec.entityName) ?? (repos[serviceKey] as IEntityService<any, any>);

  const basePath = `/api/${spec.pathSegment}`;
  const partialUpdateSchema = buildBodySchema(spec, 'update').partial();

  for (const bf of spec.byFields!) {
    app.use(
      basePath,
      createByFieldRouter({
        service: service as Parameters<typeof createByFieldRouter>[0]['service'],
        field: bf.field,
        unique: bf.unique,
        methods: bf.methods,
        entityName: spec.entityName,
        updateSchema: partialUpdateSchema,
      }),
    );
  }
}

interface MountCrudRouterDeps {
  repos: Record<string, unknown>;
  fullWriteServices: Map<string, IEntityService<any, any>>;
  useOptimisticConcurrency: boolean;
}

function usesOptimisticConcurrency(spec: CrudRouteSpec, settings: SettingsConfig): boolean {
  if (spec.readonly || spec.m2m) return false;
  return settings.useOptimisticConcurrency === true;
}

function mountCrudRouter(
  app: Express,
  spec: CrudRouteSpec,
  { repos, fullWriteServices, useOptimisticConcurrency }: MountCrudRouterDeps,
): void {
  const serviceKey = serviceKeyFor(spec.entityName);
  if (!repos[serviceKey]) {
    throw new Error(
      `createBackendApp: no repository found for ${serviceKey} (entity "${spec.entityName}")`,
    );
  }

  const service =
    fullWriteServices.get(spec.entityName) ?? (repos[serviceKey] as IEntityService<any, any>);

  const basePath = `/api/${spec.pathSegment}`;

  if (spec.readonly) {
    app.use(
      basePath,
      createReadOnlyRouter({
        service: service as Parameters<typeof createReadOnlyRouter>[0]['service'],
        entityName: spec.entityName,
      }),
    );
    return;
  }

  const createSchema = buildBodySchema(spec, 'create');
  const updateSchema = buildBodySchema(spec, 'update');
  const partialUpdateSchema = updateSchema.partial();

  app.use(
    basePath,
    createCrudRouter({
      service: service as Parameters<typeof createCrudRouter>[0]['service'],
      createSchema,
      updateSchema: partialUpdateSchema,
      entityName: spec.entityName,
      useOptimisticConcurrency,
    }),
  );
}
