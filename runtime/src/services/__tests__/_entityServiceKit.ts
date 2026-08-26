import type { ICrudRepository } from '../../repositories/ICrudRepository';
import { EntityService } from '../EntityService';
import { createMockCrudRepository } from './mockCrudRepository';

export interface TestEntity {
  id: number;
  uuid: string;
  created: string;
  updated: string;
  name: string;
}

export const TS = '2026-01-01T00:00:00Z';

/** A fresh integer-PK {@link EntityService} over a mock CRUD repository — the shared per-test setup for the EntityService suites. */
export function makeEntityService(): {
  repository: jest.Mocked<ICrudRepository<TestEntity>>;
  service: EntityService<TestEntity>;
} {
  const repository = createMockCrudRepository<TestEntity>('integer');
  const service = new EntityService<TestEntity>(repository);
  return { repository, service };
}
