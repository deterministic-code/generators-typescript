import { afterAll, beforeAll } from 'vitest';
import express from 'express';
import { type Express } from 'express';
import { createBackendApp } from '../createBackendApp';
import { connectDatabase } from '../connectDatabase';
import { parseCrudRouteSpecs } from '../loaders/parseCrudRouteSpecs';
import { parseGenericRouteSpecs } from '../loaders/parseRouteSpecs';

/** The 404-terminal fallback handler every createBackendApp integration test registers as the last route. */
export class TerminalHandler {
  handle(
    _req: unknown,
    res: { status: (n: number) => { json: (body: unknown) => unknown } },
  ): unknown {
    return res.status(404).json({ errors: [{ code: 'NOT_FOUND', message: 'route not found' }] });
  }
}

interface BootSettings {
  pluralizeTableNames?: boolean;
  useOptimisticConcurrency?: boolean;
}

interface BootOptions {
  datasourceData: unknown;
  routesData: unknown;
  ddl: string | string[];
  settingsConfig: BootSettings;
  onCrudSpecs?: (crudSpecs: ReturnType<typeof parseCrudRouteSpecs>) => void;
}

/**
 * Boot a sqlite-backed Express app from a datasource + routes doc the way the
 * createBackendApp integration suites do: open an in-memory connection, exec the
 * `ddl`, parse CRUD + generic route specs, and mount the app with the shared
 * `TerminalHandler` 404 fallback. Returns the app plus a `cleanup` that closes
 * the connection. `settingsConfig` threads runtime settings (e.g.
 * `pluralizeTableNames`); `onCrudSpecs` lets a caller assert on the parsed specs
 * before the app is built.
 */
export async function bootCrudApp({
  datasourceData,
  routesData,
  ddl,
  settingsConfig,
  onCrudSpecs,
}: BootOptions): Promise<{ app: Express; cleanup: () => Promise<void> }> {
  const conn = await connectDatabase({ backend: 'sqlite', databaseUrl: ':memory:' });
  const raw = (
    conn.datasource as unknown as { raw: () => { exec: (sql: string) => unknown } }
  ).raw();
  for (const stmt of Array.isArray(ddl) ? ddl : [ddl]) raw.exec(stmt);

  const resolvedSettings = {
    pluralizeTableNames: settingsConfig.pluralizeTableNames ?? true,
    useOptimisticConcurrency: settingsConfig.useOptimisticConcurrency ?? false,
  };
  const crudSpecs = parseCrudRouteSpecs(datasourceData, routesData);
  onCrudSpecs?.(crudSpecs);
  const app = await createBackendApp(conn, {
    backendAppConfig: {
      middleware: [{ name: 'bodyParser', type: 'app', enabled: true }],
      handlers: [
        { name: 'ErrorHandlerMiddlewareService', enabled: true },
        { name: 'TerminalHandler', enabled: true },
      ],
    },
    routeSpecs: parseGenericRouteSpecs(routesData),
    crudSpecs,
    datasourceData: datasourceData as never,
    routesData: routesData as never,
    viewTypesDoc: { types: [] } as never,
    serviceSpecs: [{ name: 'TerminalHandler', args: [] }],
    classRegistry: {
      TerminalHandler: TerminalHandler as unknown as new (...a: unknown[]) => unknown,
    },
    middlewareLookup: { get: () => express.json() } as never,
    settingsConfig: resolvedSettings,
  });
  return { app, cleanup: async () => conn.close() };
}

/**
 * Register the `beforeAll`/`afterAll` lifecycle that boots a CRUD app from
 * `options` and tears it down, returning a `() => Express` accessor the suite's
 * `it` blocks call to reach the live app. Collapses the repeated
 * boot/cleanup scaffold every createBackendApp integration suite carries.
 */
export function useCrudApp(options: BootOptions): () => Express {
  let app: Express;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ app, cleanup } = await bootCrudApp(options));
  });
  afterAll(async () => {
    await cleanup();
  });
  return () => app;
}
