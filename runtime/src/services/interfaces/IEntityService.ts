import type { PrimaryKey } from '../../repositories/PrimaryKey';
import { NameValue } from './NameValue';

interface EntityServiceOptimisticConcurrencyOptions {
  expectedUpdated?: string;
}

/**
 * Entity CRUD service. Identity is {@link primaryKey} (column + type), not a
 * field named `id` on {@link T}.
 */
export interface IEntityService<T, TId = number | string, TMutate = T> {
  readonly primaryKey: PrimaryKey;
  query(command: string, args: NameValue[]): Promise<T[]>;
  findAll(): Promise<T[]>;
  create(data: TMutate): Promise<T>;
  find(query: string, args: NameValue[]): Promise<T[]>;
  findById(id: TId): Promise<T | null>;
  findBy(whereArgs: NameValue[]): Promise<T[]>;
  update(
    id: TId,
    data: Partial<TMutate>,
    opts?: EntityServiceOptimisticConcurrencyOptions,
  ): Promise<T | null>;
  patch(
    id: TId,
    data: Partial<TMutate>,
    opts?: EntityServiceOptimisticConcurrencyOptions,
  ): Promise<T | null>;
  delete(id: TId, opts?: EntityServiceOptimisticConcurrencyOptions): Promise<boolean>;
  updateBy(whereArgs: NameValue[], data: Partial<TMutate>): Promise<number>;
  deleteBy(whereArgs: NameValue[]): Promise<number>;
}
