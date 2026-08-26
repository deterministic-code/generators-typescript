import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import mysql from 'mysql2/promise';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { PostgresDatasource } from '../../../repositories/postgres/PostgresDatasource';
import { MysqlDatasource } from '../../../repositories/mysql/MysqlDatasource';
import type { IDatasource } from '../../../repositories/IDatasource';
import type { DatabaseConnection } from '../../../repositories/buildRepoForBackend';

/** Reuse the codegen DDL emitter (not a checked-in .sql fixture) so the harness schema never drifts. */
// @ts-expect-error — the .mjs emitter ships no type declarations
import { emitInitialMigration } from '../../../../../scripts/lib/emit-sql.ts';

export type SqlEngine = 'postgres' | 'mysql';

const DB_NAME = 'app_test';
const APP_USER = 'app';
const APP_PASSWORD = 'app_pw';
const ROOT_PASSWORD = 'root_pw';

export interface SqlBackend {
  engine: SqlEngine;
  datasource: IDatasource;
  conn: DatabaseConnection;
  stop(): Promise<void>;
}

interface EngineDescriptor {
  image: string;
  port: number;
  environment: Record<string, string>;
  makeDatasource(host: string, port: number): IDatasource;
  applyDdl(host: string, port: number, ddl: string): Promise<void>;
}

const ENGINES: Record<SqlEngine, EngineDescriptor> = {
  postgres: {
    image: 'postgres:16-alpine',
    port: 5432,
    environment: {
      POSTGRES_DB: DB_NAME,
      POSTGRES_USER: APP_USER,
      POSTGRES_PASSWORD: APP_PASSWORD,
    },
    makeDatasource: (host, port) =>
      new PostgresDatasource({
        poolConfig: {
          connectionString: `postgresql://${APP_USER}:${APP_PASSWORD}@${host}:${port}/${DB_NAME}`,
        },
      }),
    // pg runs the whole semicolon-delimited DDL (incl. the dollar-quoted function) in one simple-query call.
    applyDdl: async (host, port, ddl) => {
      const setup = new PostgresDatasource({
        poolConfig: {
          connectionString: `postgresql://${APP_USER}:${APP_PASSWORD}@${host}:${port}/${DB_NAME}`,
        },
      });
      await setup.open();
      await setup.query(ddl);
      await setup.close();
    },
  },
  mysql: {
    image: 'mysql:8.0',
    port: 3306,
    environment: {
      MYSQL_DATABASE: DB_NAME,
      MYSQL_USER: APP_USER,
      MYSQL_PASSWORD: APP_PASSWORD,
      MYSQL_ROOT_PASSWORD: ROOT_PASSWORD,
    },
    makeDatasource: (host, port) =>
      new MysqlDatasource({
        poolConfig: { host, port, user: APP_USER, password: APP_PASSWORD, database: DB_NAME },
      }),
    // mysql2 rejects multi-statement bodies unless opted in; keep that flag off the app pool and run DDL on a throwaway root connection.
    applyDdl: async (host, port, ddl) => {
      const conn = await mysql.createConnection({
        host,
        port,
        user: 'root',
        password: ROOT_PASSWORD,
        database: DB_NAME,
        multipleStatements: true,
      });
      await conn.query(ddl);
      await conn.end();
    },
  },
};

async function emitSchemaDdl(engine: SqlEngine, deterministicRoot: string): Promise<string> {
  const doc = yaml.load(
    await readFile(resolve(deterministicRoot, 'types.yaml'), 'utf8'),
  );
  const { up } = emitInitialMigration(engine, doc, {
    idType: 'integer',
    withUuidColumn: true,
    pluralizeTableNames: true,
  }) as { up: { content: string } };
  return up.content;
}

/** TCP-listening fires before MySQL's real server is up, so a `SELECT 1` retry is the reliable readiness gate for both engines. */
async function waitForQueryable(datasource: IDatasource, deadlineMs: number): Promise<void> {
  let lastError: unknown;
  const start = performance.now();
  while (performance.now() - start < deadlineMs) {
    const ok = await datasource
      .query('SELECT 1')
      .then(() => true)
      .catch((err) => {
        lastError = err;
        return false;
      });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`database not queryable within ${deadlineMs}ms: ${String(lastError)}`);
}

export async function startSqlBackend(
  engine: SqlEngine,
  deterministicRoot: string,
): Promise<SqlBackend> {
  const descriptor = ENGINES[engine];
  const container: StartedTestContainer = await new GenericContainer(descriptor.image)
    .withEnvironment(descriptor.environment)
    .withExposedPorts(descriptor.port)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(descriptor.port);

  const datasource = descriptor.makeDatasource(host, port);
  await datasource.open();
  await waitForQueryable(datasource, 60_000);

  await descriptor.applyDdl(host, port, await emitSchemaDdl(engine, deterministicRoot));

  const conn: DatabaseConnection = {
    type: engine,
    datasource: datasource as DatabaseConnection['datasource'],
    middlewares: [],
    close: () => datasource.close(),
  };

  return {
    engine,
    datasource,
    conn,
    stop: async () => {
      await datasource.close();
      await container.stop();
    },
  };
}
