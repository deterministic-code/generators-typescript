import { randomUUID } from 'node:crypto';
import type { IDataSourceMiddleware } from '../../middleware/IDataSourceMiddleware';
import type { InMemoryDatasource } from './InMemoryDatasource';
import type { InMemoryTable } from './InMemoryDatasource';
import { ICrudRepository } from '../ICrudRepository';
import { columnValueMatches } from './columnValueMatches';
import { comparePrimaryKeyValues } from './comparePrimaryKey';
import { deleteRowByPredicate, deleteRowsBy, filterRows } from './inMemoryRowOps';
import { nextInMemoryId, type InMemoryIdType } from './nextInMemoryId';
import type { EntityIdentity, IdentityValue } from '../EntityIdentity';
import type { IPrimaryKeyService } from '../IPrimaryKeyService';

export interface InMemoryCrudOptions {
  middlewares?: readonly IDataSourceMiddleware[];
  hasStandardColumns?: boolean;
  /** The entity this repository serves — resolves its {@link PrimaryKey} through {@link primaryKeys}. */
  entityName: string;
  /** The one authority that resolves each entity's primary key (column + id_type), injected from the composition root. */
  primaryKeys: IPrimaryKeyService;
}

// solid-i-allow: in-memory backend has no raw-SQL surface; query() intentionally refuses until ICrudRepository separates raw-query from CRUD.
export class InMemoryCrudRepository<
  T = Record<string, unknown>,
> implements ICrudRepository<T> {
  protected readonly table: InMemoryTable;
  protected readonly middlewares: readonly IDataSourceMiddleware[];
  protected readonly hasStandardColumns: boolean;
  readonly entityName: string;
  readonly primaryKey: EntityIdentity;
  protected readonly idType: InMemoryIdType;
  protected readonly primaryKeyColumn: string;
  private readonly buildOptions: InMemoryCrudOptions;

  constructor(
    protected readonly datasource: InMemoryDatasource,
    protected readonly tableName: string,
    options: InMemoryCrudOptions,
  ) {
    this.table = datasource.getTable(tableName);
    this.buildOptions = options;
    this.middlewares = options.middlewares ?? [];
    this.hasStandardColumns = options.hasStandardColumns ?? true;
    this.entityName = options.entityName;
    this.primaryKey = options.primaryKeys.forEntity(options.entityName);
    this.idType = this.primaryKey.idType;
    this.primaryKeyColumn = this.primaryKey.column;
  }

  /** Rebuild this repository on a different in-memory datasource (a transaction-scoped view) with the identical options, so a create/update inside a transaction keeps its id_type and primary key instead of reverting to the integer defaults. */
  cloneOnto(datasource: InMemoryDatasource): this {
    const Ctor = this.constructor as new (
      datasource: InMemoryDatasource,
      tableName: string,
      options: InMemoryCrudOptions,
    ) => this;
    return new Ctor(datasource, this.tableName, this.buildOptions);
  }

  /** A uuid primary key IS the row's identity, so no separate system `uuid` column is carried (mirrors `DatasourceSettings.withUuidColumn`). */
  private get withUuidColumn(): boolean {
    return this.idType !== 'uuid';
  }

  private primaryKeyOf(row: unknown): unknown {
    return this.primaryKey.fromRow(row as Record<string, unknown>);
  }

  private matchesId(row: unknown, id: IdentityValue): boolean {
    return this.primaryKey.matches(row as Record<string, unknown>, id);
  }

  private byPrimaryKey(a: T, b: T): number {
    const av = this.primaryKeyOf(a);
    const bv = this.primaryKeyOf(b);
    if (typeof av === 'object' && av !== null && typeof bv === 'object' && bv !== null) {
      for (const column of this.primaryKey.columns()) {
        const cmp = comparePrimaryKeyValues(
          (av as Record<string, unknown>)[column],
          (bv as Record<string, unknown>)[column],
        );
        if (cmp !== 0) return cmp;
      }
      return 0;
    }
    return comparePrimaryKeyValues(av, bv);
  }

  async query<R = unknown>(_sql: string, _params?: ReadonlyArray<unknown>): Promise<R[]> {
    throw new Error('InMemory backend does not support raw SQL queries');
  }

  async find(id: IdentityValue): Promise<T | null> {
    return (this.table.rows.find((r) => this.matchesId(r, id)) as T | undefined) ?? null;
  }

  async findAll(): Promise<T[]> {
    return [...(this.table.rows as T[])].sort((a, b) => this.byPrimaryKey(a, b));
  }

  async findBy(column: string, value: unknown): Promise<T[]> {
    return filterRows(
      this.table.rows as T[],
      (r) => columnValueMatches((r as Record<string, unknown>)[column], value),
      (a, b) => this.byPrimaryKey(a, b),
    );
  }

  async findIn(column: string, values: ReadonlyArray<unknown>): Promise<T[]> {
    if (values.length === 0) return [];
    return filterRows(
      this.table.rows as T[],
      (r) => values.some((v) => columnValueMatches((r as Record<string, unknown>)[column], v)),
      (a, b) => this.byPrimaryKey(a, b),
    );
  }

  async add(data: Omit<T, 'id'>): Promise<T> {
    const provided = data as Record<string, unknown>;
    const now = new Date().toISOString();
    const standardCols = this.hasStandardColumns
      ? {
          ...(this.withUuidColumn && { uuid: randomUUID() }),
          created: now,
          updated: now,
        }
      : {};
    const identityCols = this.primaryKey.isComposite
      ? Object.fromEntries(
          this.primaryKey.columns().map((column) => {
            const value = provided[column];
            if (value === undefined || value === null) {
              throw new Error(
                `${this.tableName} uses primary key '${this.primaryKey.columns().join(', ')}' but the insert payload did not include a value for '${column}'`,
              );
            }
            return [column, value];
          }),
        )
      : {
          [this.primaryKeyColumn]: nextInMemoryId(
            this.idType,
            provided[this.primaryKeyColumn],
            () => this.table.nextId++,
          ),
        };
    const row = {
      ...standardCols,
      ...provided,
      ...identityCols,
    } as T;
    this.table.rows.push(row);
    return row;
  }

  async update(id: IdentityValue, data: Partial<Omit<T, 'id'>>): Promise<T | null> {
    const idx = this.table.rows.findIndex((r) => this.matchesId(r, id));
    if (idx === -1) return null;
    const updateBump = this.hasStandardColumns ? { updated: new Date().toISOString() } : {};
    this.table.rows[idx] = {
      ...(this.table.rows[idx] as T),
      ...data,
      ...updateBump,
    } as T;
    return this.table.rows[idx] as T;
  }

  async delete(id: IdentityValue): Promise<boolean> {
    return deleteRowByPredicate(this.table.rows as T[], (r) => this.matchesId(r, id));
  }

  async updateBy(column: string, value: unknown, data: Partial<Omit<T, 'id'>>): Promise<T[]> {
    const updateBump = this.hasStandardColumns ? { updated: new Date().toISOString() } : {};
    const updated: T[] = [];
    for (let i = 0; i < this.table.rows.length; i++) {
      const row = this.table.rows[i] as T;
      if (columnValueMatches((row as Record<string, unknown>)[column], value)) {
        const next = { ...row, ...data, ...updateBump } as T;
        this.table.rows[i] = next;
        updated.push(next);
      }
    }
    return updated.sort((a, b) => this.byPrimaryKey(a, b));
  }

  async deleteBy(column: string, value: unknown): Promise<number> {
    return deleteRowsBy(this.table, column, value);
  }
}
