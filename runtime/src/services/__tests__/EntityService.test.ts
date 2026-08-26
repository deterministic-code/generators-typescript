import { EntityService } from '../EntityService';
import { createMockCrudRepository } from './mockCrudRepository';
import { type TestEntity, TS, makeEntityService } from './_entityServiceKit';

describe('EntityService', () => {
  let repository: ReturnType<typeof makeEntityService>['repository'];
  let service: ReturnType<typeof makeEntityService>['service'];
  beforeEach(() => void ({ repository, service } = makeEntityService()));

  describe('findAll', () => {
    it('delegates to the repository and returns its result', async () => {
      const rows: TestEntity[] = [
        { id: 1, uuid: 'u1', name: 'alpha', created: TS, updated: TS },
        { id: 2, uuid: 'u2', name: 'beta', created: TS, updated: TS },
      ];
      repository.findAll.mockResolvedValue(rows);

      const result = await service.findAll();

      expect(repository.findAll).toHaveBeenCalledWith();
      expect(result).toBe(rows);
    });
  });

  describe('findById', () => {
    it('forwards the id to the repository and returns the matching row', async () => {
      const row: TestEntity = { id: 7, uuid: 'u7', name: 'seven', created: TS, updated: TS };
      repository.find.mockResolvedValue(row);

      const result = await service.findById(7);

      expect(repository.find).toHaveBeenCalledWith(7);
      expect(result).toBe(row);
    });

    it('returns null when the repository returns null', async () => {
      repository.find.mockResolvedValue(null);

      const result = await service.findById(999);

      expect(repository.find).toHaveBeenCalledWith(999);
      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('forwards the input to the repository and returns the created row', async () => {
      const input = { name: 'new' } as Omit<TestEntity, 'id' | 'uuid' | 'created' | 'updated'>;
      const created: TestEntity = { id: 1, uuid: 'u1', name: 'new', created: TS, updated: TS };
      repository.add.mockResolvedValue(created);

      const result = await service.create(input);

      expect(repository.add).toHaveBeenCalledWith(input);
      expect(result).toBe(created);
    });
  });

  describe('update', () => {
    it('forwards the id and patch to the repository and returns the updated row', async () => {
      const patch = { name: 'renamed' };
      const updated: TestEntity = { id: 1, uuid: 'u1', name: 'renamed', created: TS, updated: TS };
      repository.update.mockResolvedValue(updated);

      const result = await service.update(1, patch);

      expect(repository.update).toHaveBeenCalledWith(1, patch);
      expect(result).toBe(updated);
    });

    it('returns null when the repository returns null', async () => {
      repository.update.mockResolvedValue(null);

      const result = await service.update(999, { name: 'x' });

      expect(repository.update).toHaveBeenCalledWith(999, { name: 'x' });
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('forwards the id and returns true when the repository reports success', async () => {
      repository.delete.mockResolvedValue(true);

      const result = await service.delete(1);

      expect(repository.delete).toHaveBeenCalledWith(1);
      expect(result).toBe(true);
    });

    it('returns false when the repository returns false', async () => {
      repository.delete.mockResolvedValue(false);

      const result = await service.delete(999);

      expect(repository.delete).toHaveBeenCalledWith(999);
      expect(result).toBe(false);
    });
  });

  describe('findBy', () => {
    it('forwards the name-value pair to the repository and returns its result', async () => {
      const rows: TestEntity[] = [{ id: 1, uuid: 'u1', name: 'alpha', created: TS, updated: TS }];
      repository.findBy.mockResolvedValue(rows);

      const result = await service.findBy([{ name: 'name', value: 'alpha' }]);

      expect(repository.findBy).toHaveBeenCalledWith('name', 'alpha');
      expect(result).toBe(rows);
    });
  });

  describe('idType uuid — a uuid id IS the row key, not a separate uuid-column lookup', () => {
    const UUID = '00000000-0000-0000-0000-000000000042';
    let uuidService: EntityService<TestEntity>;

    beforeEach(() => {
      repository = createMockCrudRepository<TestEntity>('uuid');
      uuidService = new EntityService<TestEntity>(repository);
    });

    it('findById looks the uuid up by the id column, not findBy(uuid, …)', async () => {
      const row: TestEntity = {
        id: UUID as unknown as number,
        uuid: '',
        name: 'x',
        created: TS,
        updated: TS,
      };
      repository.find.mockResolvedValue(row);

      const result = await uuidService.findById(UUID);

      expect(repository.find).toHaveBeenCalledWith(UUID);
      expect(repository.findBy).not.toHaveBeenCalled();
      expect(result).toBe(row);
    });

    it('update forwards the uuid straight to repo.update without a resolveId find detour', async () => {
      const patch = { name: 'renamed' };
      const updated: TestEntity = {
        id: UUID as unknown as number,
        uuid: '',
        name: 'renamed',
        created: TS,
        updated: TS,
      };
      repository.update.mockResolvedValue(updated);

      const result = await uuidService.update(UUID, patch);

      expect(repository.update).toHaveBeenCalledWith(UUID, patch);
      expect(repository.find).not.toHaveBeenCalled();
      expect(result).toBe(updated);
    });

    it('update threads OCC opts through for a uuid id', async () => {
      repository.update.mockResolvedValue(null);

      await uuidService.update(UUID, { name: 'x' }, { expectedUpdated: TS });

      expect(repository.update).toHaveBeenCalledWith(UUID, { name: 'x' }, { expectedUpdated: TS });
      expect(repository.find).not.toHaveBeenCalled();
    });

    it('delete forwards the uuid straight to repo.delete without a resolveId find detour', async () => {
      repository.delete.mockResolvedValue(true);

      const result = await uuidService.delete(UUID);

      expect(repository.delete).toHaveBeenCalledWith(UUID);
      expect(repository.find).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('delete threads OCC opts straight to repo.delete for a uuid id', async () => {
      repository.delete.mockResolvedValue(true);

      await uuidService.delete(UUID, { expectedUpdated: TS });

      expect(repository.delete).toHaveBeenCalledWith(UUID, { expectedUpdated: TS });
      expect(repository.find).not.toHaveBeenCalled();
    });
  });

  describe('does not coerce digit-only path params (MySQL DOUBLE-truncation regression)', () => {
    it('deleteBy forwards the URL-string value to the repo verbatim', async () => {
      repository.deleteBy.mockResolvedValue(0);
      await service.deleteBy([{ name: 'notification_type', value: '1' }]);
      expect(repository.deleteBy).toHaveBeenCalledWith('notification_type', '1');
    });

    it('updateBy forwards the URL-string value to the repo verbatim', async () => {
      repository.updateBy.mockResolvedValue([]);
      await service.updateBy([{ name: 'kind', value: '42' }], { name: 'x' });
      expect(repository.updateBy).toHaveBeenCalledWith('kind', '42', { name: 'x' });
    });
  });

  describe('raw query passthroughs', () => {
    it('query forwards the command and the arg values (not the NameValue wrappers)', async () => {
      const rows: TestEntity[] = [{ id: 1, uuid: 'u1', name: 'a', created: TS, updated: TS }];
      repository.query.mockResolvedValue(rows);

      const result = await service.query('SELECT * WHERE a=? AND b=?', [
        { name: 'a', value: 'x' },
        { name: 'b', value: 2 },
      ]);

      expect(repository.query).toHaveBeenCalledWith('SELECT * WHERE a=? AND b=?', ['x', 2]);
      expect(result).toBe(rows);
    });

    it('find forwards the query and the arg values (not the NameValue wrappers)', async () => {
      const rows: TestEntity[] = [{ id: 1, uuid: 'u1', name: 'a', created: TS, updated: TS }];
      repository.query.mockResolvedValue(rows);

      const result = await service.find('SELECT * WHERE a=?', [{ name: 'a', value: 'x' }]);

      expect(repository.query).toHaveBeenCalledWith('SELECT * WHERE a=?', ['x']);
      expect(result).toBe(rows);
    });
  });

  describe('integer-PK service treats a string id as a uuid-column lookup', () => {
    const UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    it('findById resolves a string id via findBy(uuid, …) and returns the first match', async () => {
      const row: TestEntity = { id: 3, uuid: UUID, name: 'r', created: TS, updated: TS };
      repository.findBy.mockResolvedValue([row]);

      const result = await service.findById(UUID);

      expect(repository.findBy).toHaveBeenCalledWith('uuid', UUID);
      expect(repository.find).not.toHaveBeenCalled();
      expect(result).toBe(row);
    });

    it('findById returns null when no row carries the uuid', async () => {
      repository.findBy.mockResolvedValue([]);

      expect(await service.findById(UUID)).toBeNull();
    });

    it('update resolves the string id to a numeric key before updating', async () => {
      const row: TestEntity = { id: 7, uuid: UUID, name: 'r', created: TS, updated: TS };
      repository.findBy.mockResolvedValue([row]);
      const updated = { ...row, name: 'renamed' };
      repository.update.mockResolvedValue(updated);

      const result = await service.update(UUID, { name: 'renamed' });

      expect(repository.update).toHaveBeenCalledWith(7, { name: 'renamed' });
      expect(result).toBe(updated);
    });

    it('update returns null when the string id resolves to no row', async () => {
      repository.findBy.mockResolvedValue([]);

      expect(await service.update(UUID, { name: 'x' })).toBeNull();
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('update threads OCC opts through the numeric key', async () => {
      const row: TestEntity = { id: 7, uuid: UUID, name: 'r', created: TS, updated: TS };
      repository.findBy.mockResolvedValue([row]);
      repository.update.mockResolvedValue(row);

      await service.update(UUID, { name: 'x' }, { expectedUpdated: TS });

      expect(repository.update).toHaveBeenCalledWith(7, { name: 'x' }, { expectedUpdated: TS });
    });

    it('delete resolves the string id then deletes the numeric key', async () => {
      const row: TestEntity = { id: 7, uuid: UUID, name: 'r', created: TS, updated: TS };
      repository.findBy.mockResolvedValue([row]);
      repository.delete.mockResolvedValue(true);

      expect(await service.delete(UUID)).toBe(true);
      expect(repository.delete).toHaveBeenCalledWith(7);
    });

    it('delete returns false when the string id resolves to no row', async () => {
      repository.findBy.mockResolvedValue([]);

      expect(await service.delete(UUID)).toBe(false);
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('delete threads OCC opts through the numeric key', async () => {
      repository.delete.mockResolvedValue(true);

      await service.delete(9, { expectedUpdated: TS });

      expect(repository.delete).toHaveBeenCalledWith(9, { expectedUpdated: TS });
    });
  });

  describe('numeric update with OCC opts', () => {
    it('forwards the numeric id, patch, and opts straight through', async () => {
      const updated: TestEntity = { id: 4, uuid: 'u4', name: 'y', created: TS, updated: TS };
      repository.update.mockResolvedValue(updated);

      const result = await service.update(4, { name: 'y' }, { expectedUpdated: TS });

      expect(repository.update).toHaveBeenCalledWith(4, { name: 'y' }, { expectedUpdated: TS });
      expect(result).toBe(updated);
    });
  });

  describe('multi-predicate updateBy / deleteBy fall through to per-row work', () => {
    function twoAdmins(): TestEntity[] {
      return [
        { id: 1, uuid: 'u1', name: 'alpha', created: TS, updated: TS },
        { id: 2, uuid: 'u2', name: 'beta', created: TS, updated: TS },
      ];
    }

    it('updateBy filters by every predicate then counts only non-null repo updates', async () => {
      const matches = twoAdmins();
      repository.findBy.mockResolvedValue([
        ...matches,
        { id: 3, uuid: 'u3', name: 'gamma', created: TS, updated: TS },
      ]);
      repository.update.mockResolvedValueOnce(matches[0]).mockResolvedValueOnce(null);

      const count = await service.updateBy(
        [
          { name: 'status', value: 'active' },
          { name: 'name', value: 'alpha' },
        ],
        { name: 'z' },
      );

      expect(repository.findBy).toHaveBeenCalledWith('status', 'active');
      expect(count).toBe(1);
    });

    it('deleteBy filters by every predicate then counts only successful repo deletes', async () => {
      repository.findBy.mockResolvedValue([
        ...twoAdmins(),
        { id: 3, uuid: 'u3', name: 'gamma', created: TS, updated: TS },
      ]);
      repository.delete.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      const count = await service.deleteBy([
        { name: 'status', value: 'active' },
        { name: 'name', value: 'alpha' },
      ]);

      expect(count).toBe(1);
    });
  });

  describe('findBy predicate shapes', () => {
    it('returns findAll() when no predicates are supplied', async () => {
      const rows: TestEntity[] = [{ id: 1, uuid: 'u1', name: 'a', created: TS, updated: TS }];
      repository.findAll.mockResolvedValue(rows);

      const result = await service.findBy([]);

      expect(repository.findAll).toHaveBeenCalledWith();
      expect(result).toBe(rows);
    });

    it('uses findIn when one column carries multiple values', async () => {
      const rows: TestEntity[] = [
        { id: 1, uuid: 'u1', name: 'a', created: TS, updated: TS },
        { id: 2, uuid: 'u2', name: 'b', created: TS, updated: TS },
      ];
      repository.findIn.mockResolvedValue(rows);

      const result = await service.findBy([
        { name: 'name', value: 'a' },
        { name: 'name', value: 'b' },
      ]);

      expect(repository.findIn).toHaveBeenCalledWith('name', ['a', 'b']);
      expect(result).toBe(rows);
    });
  });
});
