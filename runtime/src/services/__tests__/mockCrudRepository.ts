import type { ICrudRepository } from '../../repositories/ICrudRepository';
import { EntityIdentity } from '../../repositories/EntityIdentity';
import type { StandardIdType } from '../../repositories/standardFieldConverting';

/** A fully-stubbed {@link ICrudRepository} mock for service tests — every CRUD method is a `jest.fn()`, plus the `entityName`/`primaryKey` the service reads. `idType` is explicit (no default) so a fixture states the key shape it intends; `column` defaults to the structural `id`. */
export function createMockCrudRepository<T extends { id: number | string }>(
  idType: StandardIdType,
  column = 'id',
): jest.Mocked<ICrudRepository<T>> {
  return {
    entityName: 'test',
    primaryKey: EntityIdentity.scalar(column, idType),
    query: jest.fn(),
    find: jest.fn(),
    findAll: jest.fn(),
    findBy: jest.fn(),
    findIn: jest.fn(),
    add: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    updateBy: jest.fn(),
    deleteBy: jest.fn(),
  };
}
