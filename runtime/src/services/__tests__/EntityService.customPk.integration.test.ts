// EntityService + SqliteCrudRepository over a real in-memory SQLite, exercising the custom-PK path (legacy_contact.key) through the route → service → repo → SQL chain.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SqliteDatasource } from '../../repositories/sqlite/SqliteDatasource';
import { SqliteCrudRepository } from '../../repositories/sqlite/SqliteCrudRepository';
import type { ICrudRepository } from '../../repositories/ICrudRepository';
import { EntityService } from '../EntityService';
import { testPrimaryKeys } from '../../repositories/__tests__/testPrimaryKeys';

interface LegacyContact {
  id: string;
  key: string;
  first_name: string;
  last_name: string;
}

describe('EntityService — custom primary key end-to-end', () => {
  let ds: SqliteDatasource;
  let repo: SqliteCrudRepository<LegacyContact, string>;
  let service: EntityService<LegacyContact>;

  beforeAll(async () => {
    ds = new SqliteDatasource({ dbPath: ':memory:' });
    await ds.open();
    await ds.query(`CREATE TABLE "OldContactsTbl" (
      "key" VARCHAR(64) NOT NULL PRIMARY KEY,
      "first_name" VARCHAR(128) NOT NULL,
      "last_name" VARCHAR(128) NOT NULL
    )`);
    repo = new SqliteCrudRepository<LegacyContact, string>(ds, 'OldContactsTbl', {
      entityName: 'legacy_contact',
      primaryKeys: testPrimaryKeys('string', 'key'),
    });
    service = new EntityService<LegacyContact>(
      repo as unknown as ICrudRepository<LegacyContact & { id: number | string }>,
    );
  });

  afterAll(async () => {
    await ds.close();
  });

  it('service.create writes a row and the same row is reachable by service.findById(stringKey)', async () => {
    const created = await service.create({
      key: 'cnt-001',
      first_name: 'Ada',
      last_name: 'Lovelace',
    } as never);
    expect(created.key).toBe('cnt-001');

    const found = await service.findById('cnt-001');
    expect(found).not.toBeNull();
    expect(found?.first_name).toBe('Ada');
  });

  it('service.update changes a row by string key and the row is still findable', async () => {
    await service.create({
      key: 'cnt-002',
      first_name: 'Grace',
      last_name: 'Hopper',
    } as never);

    const updated = await service.update('cnt-002', {
      last_name: 'Hopper-Murray',
    } as never);
    expect(updated?.last_name).toBe('Hopper-Murray');

    const found = await service.findById('cnt-002');
    expect(found?.last_name).toBe('Hopper-Murray');
  });

  it('service.delete by string key removes the row', async () => {
    await service.create({
      key: 'cnt-003',
      first_name: 'Linus',
      last_name: 'Torvalds',
    } as never);

    expect(await service.delete('cnt-003')).toBe(true);
    expect(await service.findById('cnt-003')).toBeNull();
  });
});
