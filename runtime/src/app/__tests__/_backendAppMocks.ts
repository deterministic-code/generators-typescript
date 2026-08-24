import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';
import { pathExists } from '../../repositories/pathExists';
import { createBackendApp } from '../createBackendApp';
import * as repoModule from '../../repositories';
import { SqliteDatasource } from '../../repositories/sqlite/SqliteDatasource';
import { SqliteCrudRepository } from '../../repositories/sqlite/SqliteCrudRepository';
import { errorHandler } from '../../middleware/errorHandler';
import type { DatabaseConnection } from '../../repositories';
import { testPrimaryKeys } from '../../repositories/__tests__/testPrimaryKeys';
import type { StandardIdType } from '../../repositories/standardFieldConverting';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The `deterministic/` directory of `samples/<sample>/`, the directory the createBackendApp deterministic-root suites hand to `deterministicRoot`. */
function sampleDeterministicDir(sample: string): string {
  return resolve(here, '..', '..', '..', '..', 'samples', sample, 'deterministic');
}

interface TempSqlite {
  ds: SqliteDatasource;
  dbPath: string;
  tempDir: string;
}

/** Open a throwaway on-disk sqlite database under the OS temp dir, exec each `tableDdl`, then each `seedSql`, and return the datasource plus the paths to clean up. */
async function openTempSqlite(
  prefix: string,
  tableDdl: readonly string[],
  seedSql: readonly string[] = [],
): Promise<TempSqlite> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(tempDir, 'test.db');
  const ds = new SqliteDatasource({ dbPath });
  await ds.open();
  for (const ddl of tableDdl) await ds.query(ddl);
  for (const seed of seedSql) await ds.query(seed);
  return { ds, dbPath, tempDir };
}

/** Restore mocks, close the datasource, and remove the temp database + directory opened by {@link openTempSqlite}. */
async function cleanupTempSqlite({ ds, dbPath, tempDir }: TempSqlite): Promise<void> {
  vi.restoreAllMocks();
  await ds.close();
  if (await pathExists(dbPath)) await fs.unlink(dbPath);
  if (await pathExists(tempDir)) await fs.rmdir(tempDir);
}

/** Build a createBackendApp over `ds` and the `deterministicRoot` fixture the way the deterministic-root suites do: spy `buildRepoForBackend` onto sqlite CRUD repos, mount with a json-body middleware, and append the shared error handler. */
async function bootDeterministicRootApp(
  ds: SqliteDatasource,
  deterministicRoot: string,
  opts: { pluralizeTableNames?: boolean; idType: StandardIdType },
): Promise<Express> {
  vi.spyOn(repoModule, 'buildRepoForBackend').mockImplementation(
    ((_conn: DatabaseConnection, entityName: string) =>
      new SqliteCrudRepository(ds, entityName, {
        entityName: 'test',
        primaryKeys: testPrimaryKeys(opts.idType),
      })) as unknown as typeof repoModule.buildRepoForBackend,
  );

  const conn = {
    type: 'sqlite',
    datasource: ds,
    close: () => ds.close(),
    middlewares: [],
  } as unknown as DatabaseConnection;

  const app = await createBackendApp(conn, {
    backendAppConfig: {
      middleware: [{ name: 'jsonBody', type: 'app', enabled: true }],
      handlers: [],
      statics: [],
    },
    deterministicRoot,
    settingsConfig: { pluralizeTableNames: opts.pluralizeTableNames ?? false },
    routeSpecs: [],
    serviceSpecs: [],
  });

  app.use(errorHandler);
  return app;
}

export interface DeterministicRootAppCtx {
  app: Express;
  ds: SqliteDatasource;
}

/** Register a sqlite-backed deterministic-root app lifecycle, handing the freshly built `{ app, ds }` to `onReady` each run so a suite can bind them to its own locals. `sample` names the `samples/<sample>` fixture; `perTest` (default) uses `beforeEach`/`afterEach`, else `beforeAll`/`afterAll`. */
export function useDeterministicRootApp(
  sample: string,
  tableDdl: readonly string[],
  seedSql: readonly string[],
  onReady: (ctx: DeterministicRootAppCtx) => void,
  opts: { idType?: StandardIdType; perTest?: boolean; pluralizeTableNames?: boolean } = {},
): void {
  let db: TempSqlite;
  const setup = async () => {
    db = await openTempSqlite(`${sample}-`, tableDdl, seedSql);
    const app = await bootDeterministicRootApp(db.ds, sampleDeterministicDir(sample), {
      idType: opts.idType ?? 'integer',
      pluralizeTableNames: opts.pluralizeTableNames,
    });
    onReady({ app, ds: db.ds });
  };
  const teardown = () => cleanupTempSqlite(db);
  const perTest = opts.perTest ?? true;
  (perTest ? beforeEach : beforeAll)(setup);
  (perTest ? afterEach : afterAll)(teardown);
}
