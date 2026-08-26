import { IRepository } from './IRepository';
import type { EntityIdentity, IdentityValue } from './EntityIdentity';

export interface OptimisticConcurrencyOptions {
  expectedUpdated?: string;
}

export interface ICrudRepository<T = Record<string, unknown>, TId = IdentityValue> extends IRepository {
  readonly entityName: string;
  readonly primaryKey: EntityIdentity;
  find(id: TId): Promise<T | null>;
  findAll(): Promise<T[]>;
  findBy(column: string, value: unknown): Promise<T[]>;
  findIn(column: string, values: ReadonlyArray<unknown>): Promise<T[]>;
  add(data: Omit<T, 'id'>): Promise<T>;
  update(
    id: TId,
    data: Partial<Omit<T, 'id'>>,
    opts?: OptimisticConcurrencyOptions,
  ): Promise<T | null>;
  delete(id: TId, opts?: OptimisticConcurrencyOptions): Promise<boolean>;
  updateBy(column: string, value: unknown, data: Partial<Omit<T, 'id'>>): Promise<T[]>;
  deleteBy(column: string, value: unknown): Promise<number>;
}
