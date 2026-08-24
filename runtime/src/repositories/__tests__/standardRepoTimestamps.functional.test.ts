import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { IDatasource } from '../IDatasource';
import type { IStandardCrudRepository } from '../IStandardCrudRepository';
import { MysqlDatasource } from '../mysql/MysqlDatasource';
import { PostgresDatasource } from '../postgres/PostgresDatasource';
import { MysqlStandardRepository } from '../mysql/MysqlStandardRepository';
import { PostgresStandardRepository } from '../postgres/PostgresStandardRepository';
import { testPrimaryKeys } from './testPrimaryKeys';
import {
  startSqlBackend,
  type SqlBackend,
  type SqlEngine,
} from '../../app/__tests__/functional/sqlContainer';

interface ProbeRow {
  id: number;
  created: string;
  updated: string;
  uuid?: string;
  name: string;
}

const contactsRoot = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'samples',
  'contacts-backend',
  'deterministic',
);

/** A minimal table the standard repo can drive without the contacts schema's FKs — just the id/uuid/created/updated shape plus one data column. */
const PROBE_DDL: Record<SqlEngine, string> = {
  mysql:
    'CREATE TABLE tstamp_probe (id INT AUTO_INCREMENT PRIMARY KEY, uuid VARCHAR(64) NOT NULL, name VARCHAR(255), created DATETIME NOT NULL, updated DATETIME NOT NULL)',
  postgres:
    'CREATE TABLE tstamp_probe (id SERIAL PRIMARY KEY, uuid TEXT NOT NULL, name TEXT, created TIMESTAMP NOT NULL, updated TIMESTAMP NOT NULL)',
};

function makeRepo(
  engine: SqlEngine,
  ds: IDatasource,
): IStandardCrudRepository<ProbeRow, number> {
  return engine === 'mysql'
    ? new MysqlStandardRepository<ProbeRow>(ds as unknown as MysqlDatasource, 'tstamp_probe', {
        withUuidColumn: true,
        entityName: 'tstamp_probe',
        primaryKeys: testPrimaryKeys('integer'),
      })
    : new PostgresStandardRepository<ProbeRow>(
        ds as unknown as PostgresDatasource,
        'tstamp_probe',
        {
          withUuidColumn: true,
          entityName: 'tstamp_probe',
          primaryKeys: testPrimaryKeys('integer'),
        },
      );
}

describe.each<SqlEngine>(['postgres', 'mysql'])(
  '%s StandardRepository auto-timestamps (real DB)',
  (engine) => {
    let backend: SqlBackend;
    let repo: IStandardCrudRepository<ProbeRow, number>;

    beforeAll(async () => {
      backend = await startSqlBackend(engine, contactsRoot);
      await backend.datasource.query(PROBE_DDL[engine]);
      repo = makeRepo(engine, backend.datasource);
    }, 180_000);

    afterAll(async () => {
      await backend?.stop();
    });

    it('binds created/updated as a Date through the datetime converter and round-trips the instant', async () => {
      const before = Date.now();
      const row = await repo.add({ name: 'probe' });
      const after = Date.now();

      expect(row.name).toBe('probe');
      expect(typeof row.uuid).toBe('string');

      const found = await repo.find(row.id);
      expect(found).not.toBeNull();

      // DATETIME/TIMESTAMP floor to the second (hence the wide window); a timezone regression would shift these by whole hours.
      for (const ts of [row.created, row.updated, found!.created, found!.updated]) {
        const ms = new Date(ts as unknown as string | Date).getTime();
        expect(ms).toBeGreaterThanOrEqual(before - 2000);
        expect(ms).toBeLessThanOrEqual(after + 2000);
      }
    });

    it('exercises the base-generated update/delete SQL against the real engine', async () => {
      const row = await repo.add({ name: 'to-change' });
      const updated = await repo.update(row.id, { name: 'changed' } as Partial<ProbeRow>);
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('changed');
      expect((await repo.find(row.id))!.name).toBe('changed');

      expect(await repo.delete(row.id)).toBe(true);
      expect(await repo.find(row.id)).toBeNull();
    });
  },
);
