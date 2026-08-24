import { IStandardCrudRepository } from '../../IStandardCrudRepository';

export interface SimpleStandardRowWithoutUuid {
  id: number;
  created: string;
  updated: string;
  name: string;
  value: number;
}

export interface SimpleStandardRowWithUuid {
  id: number;
  uuid: string;
  created: string;
  updated: string;
  name: string;
  value: number;
}

export type SimpleStandardRow = SimpleStandardRowWithoutUuid | SimpleStandardRowWithUuid;

export interface StandardContractSetup {
  repo: IStandardCrudRepository<SimpleStandardRow>;
  teardown: () => Promise<void>;
}

export interface StandardContractOptions {
  idType: 'integer' | 'biginteger' | 'uuid' | 'string';
  withUuidColumn?: boolean;
}

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function describeStandardRepositoryContract(
  name: string,
  setup: () => Promise<StandardContractSetup>,
  options: StandardContractOptions,
): void {
  const idType = options.idType;
  const withUuidColumn = options.withUuidColumn ?? true;

  describe(`${name} satisfies IStandardCrudRepository (idType=${idType}, withUuidColumn=${withUuidColumn})`, () => {
    let repo: IStandardCrudRepository<SimpleStandardRow>;
    let teardown: () => Promise<void>;

    beforeEach(async () => {
      const ctx = await setup();
      repo = ctx.repo;
      teardown = ctx.teardown;
    });

    afterEach(async () => {
      await teardown();
    });

    it('add() auto-generates uuid/id, created, and updated', async () => {
      const row = await repo.add({ name: 'a', value: 1 });
      if (idType === 'integer' || idType === 'biginteger') {
        expect(typeof row.id === 'number' || typeof row.id === 'bigint').toBe(true);
        expect(row.id).toBeGreaterThan(0);
      } else if (idType === 'uuid') {
        expect(typeof row.id).toBe('string');
        expect(row.id).toMatch(UUID_RE);
      } else if (idType === 'string') {
        expect(typeof row.id).toBe('string');
      }
      if (withUuidColumn) {
        expect((row as SimpleStandardRowWithUuid).uuid).toMatch(UUID_RE);
      }
      expect(row.created).toMatch(ISO_8601);
      expect(row.updated).toMatch(ISO_8601);
      expect(row.name).toBe('a');
    });

    it('find() returns the row with all standard fields populated', async () => {
      const created = await repo.add({ name: 'b', value: 2 });
      const found = await repo.find(created.id);
      expect(found).not.toBeNull();
      if (withUuidColumn) {
        const createdWithUuid = created as SimpleStandardRowWithUuid;
        const foundWithUuid = found as SimpleStandardRowWithUuid;
        expect(foundWithUuid.uuid).toBe(createdWithUuid.uuid);
      }
      expect(found!.created).toBe(created.created);
    });

    it('update() refreshes updated but preserves created', async () => {
      const row = await repo.add({ name: 'old', value: 1 });
      await new Promise((r) => setTimeout(r, 5));
      const updated = await repo.update(row.id, { name: 'new' });
      expect(updated).not.toBeNull();
      if (withUuidColumn) {
        const rowWithUuid = row as SimpleStandardRowWithUuid;
        const updatedWithUuid = updated as SimpleStandardRowWithUuid;
        expect(updatedWithUuid.uuid).toBe(rowWithUuid.uuid);
      }
      expect(updated!.created).toBe(row.created);
      expect(updated!.name).toBe('new');
      expect(updated!.value).toBe(1);
    });

    it('findBy() filters by an arbitrary column', async () => {
      await repo.add({ name: 'cat', value: 1 });
      await repo.add({ name: 'cat', value: 2 });
      await repo.add({ name: 'dog', value: 3 });
      const cats = await repo.findBy('name', 'cat');
      expect(cats.map((r) => r.value).sort()).toEqual([1, 2]);
    });

    it('delete() removes the row and returns true', async () => {
      const row = await repo.add({ name: 'gone', value: 1 });
      expect(await repo.delete(row.id)).toBe(true);
      expect(await repo.find(row.id)).toBeNull();
    });

    if (idType === 'string') {
      it('add() throws when id is not supplied and idType=string', async () => {
        await expect(repo.add({ name: 'a', value: 1 })).rejects.toThrow(
          /Caller-supplied id required/,
        );
      });
    }

    describe('updateBy', () => {
      it('returns [] when no row matches', async () => {
        await repo.add({ name: 'a', value: 1 });
        expect(await repo.updateBy('name', 'missing', { value: 99 })).toEqual([]);
      });

      it('updates every matching row, refreshes updated, preserves created', async () => {
        const row = await repo.add({ name: 'cat', value: 1 });
        await new Promise((r) => setTimeout(r, 5));
        const updated = await repo.updateBy('name', 'cat', { value: 9 });
        expect(updated.length).toBe(1);
        expect(updated[0].value).toBe(9);
        expect(updated[0].created).toBe(row.created);
        expect(updated[0].updated).not.toBe(row.updated);
      });
    });

    describe('deleteBy', () => {
      it('returns 0 when no row matches', async () => {
        await repo.add({ name: 'a', value: 1 });
        expect(await repo.deleteBy('name', 'missing')).toBe(0);
      });

      it('returns the number of deleted rows', async () => {
        await repo.add({ name: 'cat', value: 1 });
        await repo.add({ name: 'dog', value: 2 });
        await repo.add({ name: 'cat', value: 3 });
        expect(await repo.deleteBy('name', 'cat')).toBe(2);
        const remaining = await repo.findAll();
        expect(remaining.length).toBe(1);
        expect(remaining[0].name).toBe('dog');
      });
    });
  });
}
