import { testCompositeKeys, testPrimaryKeys } from '../testPrimaryKeys';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathExists } from '../../pathExists';
import { SqliteDatasource } from '../../sqlite/SqliteDatasource';
import { SqliteCrudRepository } from '../../sqlite/SqliteCrudRepository';
import { describeCrudRepositoryContract, type SimpleRow } from '../shared/crudRepositoryContract';
import { openSqliteTestDb } from '../shared/sqliteTestDb';

describeCrudRepositoryContract('SqliteCrudRepository', async () => {
  const { ds, teardown } = await openSqliteTestDb('crud');
  await ds.query(
    'CREATE TABLE simple (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, value INTEGER NOT NULL)',
  );
  const repo = new SqliteCrudRepository<SimpleRow>(ds, 'simple', {
    entityName: 'test',
    primaryKeys: testPrimaryKeys('integer'),
  });
  return { repo, teardown };
});

describe('SqliteCrudRepository uuid column auto-fill', () => {
  async function setupWithUuidTable() {
    const dbPath = path.join(os.tmpdir(), `sqlite-crud-uuid-${Date.now()}-${Math.random()}.db`);
    const ds = new SqliteDatasource({ dbPath });
    await ds.open();
    await ds.query(
      `CREATE TABLE link (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid VARCHAR(36) NOT NULL UNIQUE,
        a INTEGER NOT NULL,
        b INTEGER NOT NULL
      )`,
    );
    type LinkRow = { id: number; uuid: string; a: number; b: number };
    const repo = new SqliteCrudRepository<LinkRow>(ds, 'link', {
      entityName: 'test',
      primaryKeys: testPrimaryKeys('integer'),
    });
    return {
      ds,
      repo,
      dbPath,
      cleanup: async () => {
        await ds.close();
        if (await pathExists(dbPath)) await fs.unlink(dbPath);
      },
    };
  }

  it('generates a uuid when the table has a uuid column and caller did not supply one', async () => {
    const { repo, cleanup } = await setupWithUuidTable();
    try {
      const row = await repo.add({ a: 1, b: 2 } as never);
      expect(row.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    } finally {
      await cleanup();
    }
  });

  it('preserves a caller-supplied uuid', async () => {
    const { repo, cleanup } = await setupWithUuidTable();
    try {
      const supplied = '11111111-1111-4111-8111-111111111111';
      const row = await repo.add({ uuid: supplied, a: 1, b: 2 } as never);
      expect(row.uuid).toBe(supplied);
    } finally {
      await cleanup();
    }
  });

  it('does not inject uuid when the table has no uuid column', async () => {
    const dbPath = path.join(os.tmpdir(), `sqlite-crud-no-uuid-${Date.now()}-${Math.random()}.db`);
    const ds = new SqliteDatasource({ dbPath });
    await ds.open();
    await ds.query(
      'CREATE TABLE plain (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, value INTEGER NOT NULL)',
    );
    const repo = new SqliteCrudRepository<SimpleRow>(ds, 'plain', {
      entityName: 'test',
      primaryKeys: testPrimaryKeys('integer'),
    });
    try {
      const row = await repo.add({ name: 'a', value: 1 });
      expect(row.id).toBeGreaterThan(0);
      expect((row as unknown as Record<string, unknown>).uuid).toBeUndefined();
    } finally {
      await ds.close();
      if (await pathExists(dbPath)) await fs.unlink(dbPath);
    }
  });
});

describe('SqliteCrudRepository custom primary key column', () => {
  async function setupWithStringPk() {
    const dbPath = path.join(os.tmpdir(), `sqlite-crud-strpk-${Date.now()}-${Math.random()}.db`);
    const ds = new SqliteDatasource({ dbPath });
    await ds.open();
    await ds.query(
      `CREATE TABLE legacy (
        key TEXT PRIMARY KEY NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL
      )`,
    );
    type LegacyRow = { id: string; key: string; first_name: string; last_name: string };
    const repo = new SqliteCrudRepository<LegacyRow, string>(ds, 'legacy', {
      entityName: 'test',
      primaryKeys: testPrimaryKeys('string', 'key'),
    });
    return {
      ds,
      repo,
      cleanup: async () => {
        await ds.close();
        if (await pathExists(dbPath)) await fs.unlink(dbPath);
      },
    };
  }

  it('insert + find: routes the WHERE clause through the configured primary-key column', async () => {
    const { repo, cleanup } = await setupWithStringPk();
    try {
      await repo.add({
        key: 'cnt-001',
        first_name: 'Ada',
        last_name: 'Lovelace',
      } as never);
      const row = await repo.find('cnt-001');
      expect(row?.first_name).toBe('Ada');
    } finally {
      await cleanup();
    }
  });

  it('update by string PK: WHERE clause uses configured column', async () => {
    const { repo, cleanup } = await setupWithStringPk();
    try {
      await repo.add({
        key: 'cnt-002',
        first_name: 'Grace',
        last_name: 'Hopper',
      } as never);
      const updated = await repo.update('cnt-002', { last_name: 'Hopper-Murray' });
      expect(updated?.last_name).toBe('Hopper-Murray');
    } finally {
      await cleanup();
    }
  });

  it('delete by string PK: WHERE clause uses configured column', async () => {
    const { repo, cleanup } = await setupWithStringPk();
    try {
      await repo.add({
        key: 'cnt-003',
        first_name: 'Linus',
        last_name: 'Torvalds',
      } as never);
      expect(await repo.delete('cnt-003')).toBe(true);
      expect(await repo.find('cnt-003')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('findAll orders by the configured PK column (no hardcoded "id")', async () => {
    const { repo, cleanup } = await setupWithStringPk();
    try {
      await repo.add({ key: 'b', first_name: 'B', last_name: '' } as never);
      await repo.add({ key: 'a', first_name: 'A', last_name: '' } as never);
      const rows = await repo.findAll();
      expect(rows.map((r) => r.key)).toEqual(['a', 'b']);
    } finally {
      await cleanup();
    }
  });

  it('omitting the configured PK in add() surfaces a clear constraint error from sqlite', async () => {
    const { repo, cleanup } = await setupWithStringPk();
    try {
      await expect(repo.add({ first_name: 'Anon', last_name: 'Anon' } as never)).rejects.toThrow(
        /NOT NULL constraint failed|primary key/i,
      );
    } finally {
      await cleanup();
    }
  });
});

describe('SqliteCrudRepository composite primary key', () => {
  type LinkRow = { left_id: number; right_id: number; label: string };

  async function setup() {
    const dbPath = path.join(os.tmpdir(), `sqlite-crud-comp-${Date.now()}-${Math.random()}.db`);
    const ds = new SqliteDatasource({ dbPath });
    await ds.open();
    await ds.query(
      `CREATE TABLE links (
        left_id INTEGER NOT NULL,
        right_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        PRIMARY KEY (left_id, right_id)
      )`,
    );
    const repo = new SqliteCrudRepository<LinkRow>(ds, 'links', {
      entityName: 'link',
      primaryKeys: testCompositeKeys([
        { column: 'left_id', idType: 'integer' },
        { column: 'right_id', idType: 'integer' },
      ]),
    });
    return {
      repo,
      cleanup: async () => {
        await ds.close();
        if (await pathExists(dbPath)) await fs.unlink(dbPath);
      },
    };
  }

  it('add/find/update/delete address both identity columns', async () => {
    const { repo, cleanup } = await setup();
    try {
      const created = await repo.add({ left_id: 1, right_id: 2, label: 'ab' });
      expect(created).toEqual(expect.objectContaining({ left_id: 1, right_id: 2, label: 'ab' }));
      expect(await repo.find({ left_id: 1, right_id: 2 })).toEqual(
        expect.objectContaining({ label: 'ab' }),
      );
      expect(await repo.find({ left_id: 1, right_id: 9 })).toBeNull();
      await repo.update({ left_id: 1, right_id: 2 }, { label: 'changed' });
      expect((await repo.find({ left_id: 1, right_id: 2 }))?.label).toBe('changed');
      expect(await repo.delete({ left_id: 1, right_id: 2 })).toBe(true);
      expect(await repo.find({ left_id: 1, right_id: 2 })).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

describe('SqliteCrudRepository identifier validation', () => {
  it('rejects an invalid table name', () => {
    const ds = new SqliteDatasource({ dbPath: ':memory:' });
    expect(
      () =>
        new SqliteCrudRepository<SimpleRow>(ds, 'bad name', {
          entityName: 'test',
          primaryKeys: testPrimaryKeys('integer'),
        }),
    ).toThrow('Invalid SQL identifier');
  });

  it('rejects an invalid column name in findBy', async () => {
    const dbPath = path.join(os.tmpdir(), `sqlite-crud-id-${Date.now()}.db`);
    const ds = new SqliteDatasource({ dbPath });
    await ds.open();
    await ds.query('CREATE TABLE simple (id INTEGER PRIMARY KEY, name TEXT, value INTEGER)');
    const repo = new SqliteCrudRepository<SimpleRow>(ds, 'simple', {
      entityName: 'test',
      primaryKeys: testPrimaryKeys('integer'),
    });
    await expect(repo.findBy('bad column', 'x')).rejects.toThrow('Invalid SQL identifier');
    await ds.close();
    if (await pathExists(dbPath)) await fs.unlink(dbPath);
  });
});
