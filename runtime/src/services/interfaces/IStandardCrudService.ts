import { ICrudService } from './ICrudService';
import type { PrimaryKey } from '../../repositories/PrimaryKey';
import type { StandardSystemKeys } from '../../repositories/IStandardCrudRepository';

/**
 * The row shape every standard CRUD service, router, and enrichment wrapper is
 * generic over: an `id` (number or string — string covers a custom string
 * primary_key like `legacy_contact.key`) plus the optional standard audit
 * columns. `uuid`/`created`/`updated` are optional because `skip_migrations`
 * and readonly-lookup entities map to tables that may not carry them — a
 * required `uuid` here is what wrongly rejected string-id lookup entities.
 */
export type StandardRow = {
  id: number | string;
  uuid?: string;
  created?: string | Date;
  updated?: string | Date;
};

/**
 * Standard CRUD service over a {@link StandardRow}. See that type for why the
 * audit columns are optional in the generic constraint.
 */
export interface IStandardCrudService<
  T extends StandardRow,
  TMutate = Omit<T, StandardSystemKeys>,
> extends ICrudService<T, TMutate> {
  readonly primaryKey: PrimaryKey;
}
