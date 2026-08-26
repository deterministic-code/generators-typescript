import { ICrudRepository, OptimisticConcurrencyOptions } from './ICrudRepository';

/** Keys the standard repo fills on write — omitted from add/update payloads. */
export type StandardSystemKeys = 'id' | 'uuid' | 'created' | 'updated';

export interface IStandardCrudRepository<
  T extends object = { id: unknown },
  TId = number,
> extends Omit<ICrudRepository<T, TId>, 'add' | 'update' | 'updateBy'> {
  add(data: Omit<T, StandardSystemKeys>): Promise<T>;
  update(
    id: TId,
    data: Partial<Omit<T, StandardSystemKeys>>,
    opts?: OptimisticConcurrencyOptions,
  ): Promise<T | null>;
  updateBy(
    column: string,
    value: unknown,
    data: Partial<Omit<T, StandardSystemKeys>>,
  ): Promise<T[]>;
}
