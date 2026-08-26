import { ICrudRepository } from '../repositories/ICrudRepository';
import type { EntityIdentity } from '../repositories/EntityIdentity';
import type { IDatasource } from '../repositories/IDatasource';
import { IEntityService } from './interfaces/IEntityService';
import { NameValue } from './interfaces/NameValue';

export class EntityService<T, TId = number | string, TMutate = Partial<T>> implements IEntityService<
  T,
  TId,
  TMutate
> {
  readonly primaryKey: EntityIdentity;
  protected readonly primaryKeyColumn: string;
  protected readonly hasCustomPrimaryKey: boolean;
  protected readonly idIsUuid: boolean;
  /** True when the incoming id IS the row's key — a custom PK ("cnt-001"), a uuid `id`, or a composite identity — so lookups/mutations go straight to the key columns, never the `findBy('uuid', …)` / `resolveId` detour that targets a separate integer key. */
  protected readonly idIsRowKey: boolean;

  constructor(protected readonly repository: ICrudRepository<T, TId>) {
    const pk = repository.primaryKey;
    this.primaryKey = pk;
    this.primaryKeyColumn = pk.column;
    this.hasCustomPrimaryKey = pk.column !== 'id' || pk.isComposite;
    this.idIsUuid = pk.idType === 'uuid';
    this.idIsRowKey = this.hasCustomPrimaryKey || this.idIsUuid;
  }

  async query(command: string, args: NameValue[]): Promise<T[]> {
    return (await this.repository.query<T>(
      command,
      args.map((a) => a.value),
    )) as T[];
  }

  async findAll(): Promise<T[]> {
    return this.repository.findAll();
  }

  async create(data: TMutate): Promise<T> {
    return this.repository.add(data as unknown as Omit<T, 'id'>);
  }

  async find(query: string, args: NameValue[]): Promise<T[]> {
    return (await this.repository.query<T>(
      query,
      args.map((a) => a.value),
    )) as T[];
  }

  async findById(id: TId): Promise<T | null> {
    if (this.idIsRowKey) {
      return this.repository.find(id);
    }
    if (typeof id === 'number') {
      return this.repository.find(id as TId);
    }
    const rows = await this.repository.findBy('uuid', id);
    return rows[0] ?? null;
  }

  async findBy(whereArgs: NameValue[]): Promise<T[]> {
    return this.findByInternal(whereArgs);
  }

  async update(
    id: TId,
    data: Partial<TMutate>,
    opts?: { expectedUpdated?: string },
  ): Promise<T | null> {
    const payload = data as Partial<Omit<T, 'id'>>;
    if (this.idIsRowKey) {
      return opts === undefined
        ? this.repository.update(id, payload)
        : this.repository.update(id, payload, opts);
    }
    const numericId = await this.resolveId(id);
    if (numericId === null) return null;
    return opts === undefined
      ? this.repository.update(numericId as TId, payload)
      : this.repository.update(numericId as TId, payload, opts);
  }

  async patch(
    id: TId,
    data: Partial<TMutate>,
    opts?: { expectedUpdated?: string },
  ): Promise<T | null> {
    return this.update(id, data, opts);
  }

  async delete(id: TId, opts?: { expectedUpdated?: string }): Promise<boolean> {
    if (this.idIsRowKey) {
      return opts === undefined
        ? this.repository.delete(id)
        : this.repository.delete(id, opts);
    }
    const numericId = await this.resolveId(id);
    if (numericId === null) return false;
    return opts === undefined
      ? this.repository.delete(numericId as TId)
      : this.repository.delete(numericId as TId, opts);
  }

  async updateBy(whereArgs: NameValue[], data: Partial<TMutate>): Promise<number> {
    const payload = data as Partial<Omit<T, 'id'>>;
    if (whereArgs.length === 1) {
      const { name, value } = whereArgs[0];
      const updated = await this.repository.updateBy(name, value, payload);
      return updated.length;
    }
    const matches = await this.findByInternal(whereArgs);
    let count = 0;
    for (const row of matches) {
      const key = this.rowKey(row);
      if (key === undefined) continue;
      const updated = await this.repository.update(key as TId, payload);
      if (updated !== null) count++;
    }
    return count;
  }

  async deleteBy(whereArgs: NameValue[]): Promise<number> {
    if (whereArgs.length === 1) {
      const { name, value } = whereArgs[0];
      return this.repository.deleteBy(name, value);
    }
    const matches = await this.findByInternal(whereArgs);
    let count = 0;
    for (const row of matches) {
      const key = this.rowKey(row);
      if (key === undefined) continue;
      if (await this.repository.delete(key as TId)) count++;
    }
    return count;
  }

  async runInTransaction<R>(
    datasource: IDatasource,
    withTxnRepoFn: (
      repo: ICrudRepository<T, TId>,
      txn: IDatasource,
    ) => ICrudRepository<T, TId>,
    fn: (txnService: this) => Promise<R>,
  ): Promise<R> {
    return datasource.runInTransaction(async (txn) => {
      const txnRepo = withTxnRepoFn(this.repository, txn);
      const clone = Object.create(Object.getPrototypeOf(this));
      Object.assign(clone, this, { repository: txnRepo });
      return fn(clone as this);
    });
  }

  private rowKey(row: T): unknown {
    return this.primaryKey.valueOf(row as Record<string, unknown>);
  }

  private async findByInternal(whereArgs: NameValue[]): Promise<T[]> {
    if (whereArgs.length === 0) return this.repository.findAll();

    const byName = new Map<string, unknown[]>();
    for (const { name, value } of whereArgs) {
      const existing = byName.get(name);
      if (existing) existing.push(value);
      else byName.set(name, [value]);
    }

    const entries = Array.from(byName.entries());
    const [firstName, firstValues] = entries[0];
    let rows: T[] =
      firstValues.length === 1
        ? await this.repository.findBy(firstName, firstValues[0])
        : await this.repository.findIn(firstName, firstValues);

    for (let i = 1; i < entries.length; i++) {
      const [name, values] = entries[i];
      rows = rows.filter((r) => values.includes((r as Record<string, unknown>)[name]));
    }
    return rows;
  }

  private async resolveId(id: TId): Promise<number | null> {
    if (typeof id === 'number') return id;
    const row = await this.findById(id);
    if (!row) return null;
    const value = this.rowKey(row);
    return typeof value === 'number' ? value : null;
  }
}
