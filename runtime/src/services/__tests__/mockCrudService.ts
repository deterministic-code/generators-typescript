import { IEntityService } from '../interfaces/IEntityService';
import { PrimaryKey } from '../../repositories/PrimaryKey';
import type { StandardIdType } from '../../repositories/standardFieldConverting';

/** A fully-stubbed {@link IEntityService} mock for router/service tests — every method is a `jest.fn()`, with `findAll`/`findBy` pre-resolved to `[]` so unconfigured list/lookup calls don't reject. `idType` is explicit (no default) so a fixture states the key shape it intends; `column` defaults to the structural `id`. Shared so the stub lives one place. */
export function createMockCrudService<T>(
  idType: StandardIdType,
  column = 'id',
): jest.Mocked<IEntityService<T>> {
  return {
    primaryKey: new PrimaryKey(column, idType),
    query: jest.fn(),
    findAll: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    find: jest.fn(),
    findById: jest.fn(),
    findBy: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    updateBy: jest.fn(),
    deleteBy: jest.fn(),
  };
}
