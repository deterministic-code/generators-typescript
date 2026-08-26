import { InMemoryCrudRepository } from '../../inmemory/InMemoryCrudRepository';
import { InMemoryDatasource } from '../../inmemory/InMemoryDatasource';
import { describeCrudRepositoryContract, type SimpleRow } from '../shared/crudRepositoryContract';
import { testCompositeKeys, testPrimaryKeys } from '../testPrimaryKeys';

describeCrudRepositoryContract('InMemoryCrudRepository', async () => {
  const datasource = new InMemoryDatasource();
  const repo = new InMemoryCrudRepository<SimpleRow>(datasource, 'test_table', {
    entityName: 'test_table',
    primaryKeys: testPrimaryKeys('integer'),
  });
  return {
    repo,
    teardown: async () => {},
  };
});

type ContactLike = { id: number; uuid?: string; created?: string; updated?: string; name: string };

async function addContact(
  opts?: Partial<ConstructorParameters<typeof InMemoryCrudRepository>[2]>,
  extra: Record<string, unknown> = {},
): Promise<ContactLike & Record<string, unknown>> {
  const datasource = new InMemoryDatasource();
  const repo = new InMemoryCrudRepository<ContactLike>(datasource, 'test_table', {
    entityName: 'test_table',
    primaryKeys: testPrimaryKeys('integer'),
    ...opts,
  });
  return (await repo.add({ name: 'Alice', ...extra } as Omit<ContactLike, 'id'>)) as ContactLike &
    Record<string, unknown>;
}

describe('InMemoryCrudRepository extras', () => {
  it('query() inherits the no-SQL behavior', async () => {
    const datasource = new InMemoryDatasource();
    const repo = new InMemoryCrudRepository<SimpleRow>(datasource, 'test_table', {
      entityName: 'test_table',
      primaryKeys: testPrimaryKeys('integer'),
    });
    await expect(repo.query('SELECT 1')).rejects.toThrow(
      'InMemory backend does not support raw SQL queries',
    );
  });

  it('add() populates server-generated audit columns (uuid, created, updated) so consumers that GET the row back see the same shape Sqlite would return', async () => {
    const row = await addContact();
    expect(typeof row.uuid).toBe('string');
    expect(row.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof row.created).toBe('string');
    expect(row.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof row.updated).toBe('string');
    expect(row.created).toBe(row.updated);
  });

  it('add() defaults to a numeric id and carries a system uuid column when no idType is given', async () => {
    const row = await addContact();
    expect(typeof row.id).toBe('number');
    expect(typeof row.uuid).toBe('string');
    expect(row.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("add() with idType:'uuid' generates a uuid-string id and carries NO separate uuid column", async () => {
    const row = await addContact({ primaryKeys: testPrimaryKeys('uuid') });
    expect(typeof row.id).toBe('string');
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(row).not.toHaveProperty('uuid');
  });

  it('add() preserves an explicit uuid passed in by the caller', async () => {
    const row = await addContact(undefined, { uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    expect(row.uuid).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  it('update() refreshes the updated timestamp without rewriting created or uuid', async () => {
    type ContactLike = {
      id: number;
      uuid?: string;
      created?: string;
      updated?: string;
      name: string;
    };
    const datasource = new InMemoryDatasource();
    const repo = new InMemoryCrudRepository<ContactLike>(datasource, 'test_table', {
      entityName: 'test_table',
      primaryKeys: testPrimaryKeys('integer'),
    });
    const row = await repo.add({ name: 'Alice' } as Omit<ContactLike, 'id'>);
    const originalCreated = row.created;
    const originalUuid = row.uuid;
    await new Promise((r) => setTimeout(r, 5));
    const updated = await repo.update(row.id, { name: 'Bob' });
    expect(updated).toBeTruthy();
    expect(updated!.uuid).toBe(originalUuid);
    expect(updated!.created).toBe(originalCreated);
    expect(updated!.updated).not.toBe(originalCreated);
  });
});

type LegacyLike = { id: string; key: string; first_name: string };

describe('InMemoryCrudRepository custom primary key', () => {
  const makeRepo = (): InMemoryCrudRepository<LegacyLike> =>
    new InMemoryCrudRepository<LegacyLike>(new InMemoryDatasource(), 'OldContactsTbl', {
      entityName: 'legacy_contact',
      primaryKeys: testPrimaryKeys('string', 'key'),
    });

  it("add() keys the row by the caller-supplied custom PK ('key'), not a hardcoded `id` (the legacy_contact 500)", async () => {
    const row = await makeRepo().add({
      key: 'cnt-001',
      first_name: 'Ada',
    } as Omit<LegacyLike, 'id'>);
    expect(row.key).toBe('cnt-001');
    expect(row).not.toHaveProperty('id');
  });

  it('find/update/delete resolve the row through the custom PK column', async () => {
    const repo = makeRepo();
    await repo.add({ key: 'cnt-001', first_name: 'Ada' } as Omit<LegacyLike, 'id'>);
    expect((await repo.find('cnt-001'))?.first_name).toBe('Ada');
    await repo.update('cnt-001', { first_name: 'Grace' });
    expect((await repo.find('cnt-001'))?.first_name).toBe('Grace');
    expect(await repo.delete('cnt-001')).toBe(true);
    expect(await repo.find('cnt-001')).toBeNull();
  });

  it("add() still throws when idType:'string' and the custom PK value is missing", async () => {
    await expect(
      makeRepo().add({ first_name: 'Ada' } as unknown as Omit<LegacyLike, 'id'>),
    ).rejects.toThrow("Caller-supplied id required when idType='string'");
  });
});

type LinkRow = { left_id: number; right_id: number; label: string };

describe('InMemoryCrudRepository composite primary key', () => {
  const makeRepo = (): InMemoryCrudRepository<LinkRow> =>
    new InMemoryCrudRepository<LinkRow>(new InMemoryDatasource(), 'links', {
      entityName: 'link',
      primaryKeys: testCompositeKeys([
        { column: 'left_id', idType: 'integer' },
        { column: 'right_id', idType: 'integer' },
      ]),
    });

  it('find/update/delete address the row by both key columns', async () => {
    const repo = makeRepo();
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
  });

  it('add throws when a composite key column is missing', async () => {
    await expect(
      makeRepo().add({ left_id: 1, label: 'x' } as Omit<LinkRow, 'id'>),
    ).rejects.toThrow(/right_id/);
  });
});
