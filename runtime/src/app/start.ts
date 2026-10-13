import type { Express } from 'express';
import { connectDatabase, type ConnectDatabaseOptions } from './connectDatabase';
import { createBackendApp, type CreateAppOptions } from './createBackendApp';
import type { DatabaseConnection } from './database';

export interface StartOptions<TBuildOpts = CreateAppOptions> {
  port?: number;
  appName?: string;
  connect?: ConnectDatabaseOptions;
  createBackendApp?: TBuildOpts;
  buildApp?: (conn: DatabaseConnection, options: TBuildOpts) => Promise<Express>;
}

export interface StartHandle {
  app: Express;
  conn: DatabaseConnection;
  close: () => Promise<void>;
}

export async function start<TBuildOpts = CreateAppOptions>(
  options: StartOptions<TBuildOpts> = {} as StartOptions<TBuildOpts>,
): Promise<StartHandle> {
  // 4001 is the typescript-lane dev default: 4000 is the deterministic dev server and 4002 the rust lane, so all three can run at once (see DEV_PORTS in scripts/codegen/lib/create-backend-app-model.mjs).
  const port = options.port ?? Number(process.env.PORT ?? 4001);
  const appName = options.appName ?? 'deterministic';

  const conn = await connectDatabase(options.connect);
  const buildApp =
    options.buildApp ??
    (createBackendApp as unknown as (
      conn: DatabaseConnection,
      options: TBuildOpts,
    ) => Promise<Express>);
  const app = await buildApp(conn, options.createBackendApp ?? ({} as TBuildOpts));

  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`${appName} listening on http://localhost:${port} (backend=${conn.type})`);
  });

  const shutdown = (signal: string): void => {
    // eslint-disable-next-line no-console
    console.log(`\nReceived ${signal}, shutting down.`);
    server.close(async () => {
      try {
        await conn.close();
      } finally {
        process.exit(0);
      }
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return {
    app,
    conn,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await conn.close();
    },
  };
}
