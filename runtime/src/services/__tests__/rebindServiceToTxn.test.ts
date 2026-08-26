import { describe, it, expect, vi } from 'vitest';
import { EntityService } from '../EntityService';
import { LookupEnrichedService } from '../LookupEnrichedService';
import { EagerChildLoadingService } from '../EagerChildLoadingService';
import { rebindServiceToTxn } from '../rebindServiceToTxn';
import type { ICrudRepository } from '../../repositories/ICrudRepository';
import { PrimaryKey } from '../../repositories/PrimaryKey';

function mockRepo(): ICrudRepository<any> {
  return {
    entityName: 'test',
    primaryKey: new PrimaryKey('id', 'integer'),
    query: vi.fn(async () => []),
    findAll: vi.fn(async () => []),
    find: vi.fn(async () => null),
    findBy: vi.fn(async () => []),
    findIn: vi.fn(async () => []),
    add: vi.fn(async () => ({ id: 1 })),
    update: vi.fn(async () => null),
    updateBy: vi.fn(async () => []),
    delete: vi.fn(async () => true),
    deleteBy: vi.fn(async () => 0),
  } as unknown as ICrudRepository<any>;
}

describe('rebindServiceToTxn', () => {
  it('rebinds through EagerChildLoading + LookupEnriched wrappers so the inner op uses the txn repo, not the pool repo', async () => {
    const poolRepo = mockRepo();
    const txnRepo = mockRepo();
    // Mirrors the contact stack: EagerChildLoading(LookupEnriched(Base(poolRepo))).
    const base = new EntityService(poolRepo);
    const enriched = new LookupEnrichedService(base as never, []);
    const stack = new EagerChildLoadingService(enriched as never, [], new Map());

    const rebound = rebindServiceToTxn(stack, txnRepo);
    await rebound.delete(1);

    expect(txnRepo.delete).toHaveBeenCalledWith(1);
    expect(poolRepo.delete).not.toHaveBeenCalled();
  });

  it('a plain repository-backed service is cloned with the txn repo swapped in', async () => {
    const poolRepo = mockRepo();
    const txnRepo = mockRepo();
    const rebound = rebindServiceToTxn(new EntityService(poolRepo), txnRepo);

    await rebound.delete(2);

    expect(txnRepo.delete).toHaveBeenCalledWith(2);
    expect(poolRepo.delete).not.toHaveBeenCalled();
  });
});
