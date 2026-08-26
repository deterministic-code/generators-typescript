import type { ICrudRepository } from '../repositories/ICrudRepository';
import type { IEntityService } from './interfaces/IEntityService';

interface TxnRebindable {
  withTxnRepository(repo: ICrudRepository<any>): IEntityService<any>;
}

function isTxnRebindable(service: unknown): service is TxnRebindable {
  return (
    typeof service === 'object' &&
    service !== null &&
    typeof (service as TxnRebindable).withTxnRepository === 'function'
  );
}

/**
 * Rebinds a service so its data operations run against `repo` (a transaction-bound
 * repository) instead of the pool.
 *
 * Wrapper services (lookup enrichment, eager child loading) delegate through a
 * private inner service, so a shallow `repository` swap never reaches it — the
 * parent write then runs on a second pooled connection and, inside a cascade
 * delete, deadlocks against the outer transaction's still-open child deletes.
 * Rebindable wrappers implement `withTxnRepository` to rebuild themselves around
 * a txn-bound inner service; a plain repository-backed service is cloned with
 * the txn repository swapped in.
 */
export function rebindServiceToTxn<S extends IEntityService<any>>(
  service: S,
  repo: ICrudRepository<any>,
): S {
  if (isTxnRebindable(service)) {
    return service.withTxnRepository(repo) as S;
  }
  const clone = Object.create(Object.getPrototypeOf(service));
  Object.assign(clone, service, { repository: repo });
  return clone as S;
}
