import { PreconditionFailedError } from '../errors/AppError';
import type { SupportedDatasource } from '../converters/ITypeFieldConverter';
import { getDefaultConverters } from '../converters/registry';
import { IStandardCrudRepository, type StandardSystemKeys } from './IStandardCrudRepository';
import { PrimaryKey } from './PrimaryKey';
import { IDatasource } from './IDatasource';
import { assertValidIdentifier } from './sqlIdentifier';
import { placeholderList } from './sqlPlaceholders';
import {
  StandardFieldConverter,
  buildStandardInsert,
  coerceScalarId,
  type StandardIdType,
  type StandardRepositoryOptions,
} from './standardFieldConverting';
import {
  createViaSp,
  deleteViaSp,
  updateViaSp,
  type StandardSpClient,
  type StandardSpHost,
} from './standardSpWriter';

/**
 * The dialect specifics the shared CRUD implementation needs at construction time and
 * while shaping SQL: how identifiers are quoted, how bind placeholders are spelled, how
 * a stored-procedure client is built, and the trailing `RETURNING` clauses (empty on
 * dialects that read a write back via affected-rows / a follow-up `find`).
 */
export interface StandardDialectConfig {
  readonly converterDialect: SupportedDatasource;
  quoteId(name: string): string;
  placeholder(index0: number): string;
  makeSpClient(datasource: IDatasource): StandardSpClient;
  readonly insertReturning: string;
  readonly mutationReturning: string;
  readonly deleteReturning: string;
}

/**
 * The shared CRUD implementation of every dialect `*StandardRepository`. Subclasses
 * supply the dialect's static SQL shape via a {@link StandardDialectConfig} to `super`,
 * and the two write-result hooks (`resolveInsertedRow` / `updatedRow` / `affectedOf`)
 * that must read state off `this`; every SQL-shaping and value-binding decision lives
 * here once.
 */
export abstract class AbstractStandardRepository<
  T extends { id: TId },
  TId,
>
  implements IStandardCrudRepository<T, TId>, StandardSpHost<T, TId>
{
  protected readonly tableName: string;
  readonly fieldConverter: StandardFieldConverter;
  readonly idType: StandardIdType;
  readonly primaryKey: PrimaryKey;
  protected readonly withUuidColumn: boolean;
  readonly useOptimisticConcurrency: boolean;
  readonly entityName: string;
  protected readonly entityNamePlural: string;
  readonly spClient: StandardSpClient | null;

  protected readonly datasource: IDatasource;
  protected readonly dialect: StandardDialectConfig;

  constructor(
    deps: { datasource: IDatasource; dialect: StandardDialectConfig },
    tableName: string,
    options: StandardRepositoryOptions,
  ) {
    const { datasource, dialect } = deps;
    this.datasource = datasource;
    this.dialect = dialect;
    this.fieldConverter = new StandardFieldConverter(
      options.converters ?? getDefaultConverters(dialect.converterDialect, 'typescript'),
      options.columnTypes,
    );
    this.primaryKey = options.primaryKeys.forEntity(options.entityName);
    this.idType = this.primaryKey.idType;
    this.withUuidColumn = options.withUuidColumn ?? true;
    this.useOptimisticConcurrency = options.useOptimisticConcurrency === true;
    this.entityName = assertValidIdentifier(options.entityName);
    this.entityNamePlural = assertValidIdentifier(
      options.entityNamePlural ?? `${this.entityName}s`,
    );
    this.tableName = dialect.quoteId(tableName);
    this.spClient =
      options.useStoredProcedures === true ? dialect.makeSpClient(this.datasource) : null;
  }

  protected abstract resolveInsertedRow(raw: unknown[], presetId: TId | undefined): Promise<T>;
  protected abstract affectedOf(raw: unknown[]): number;

  protected updatedRow(_raw: unknown[], id: TId): Promise<T | null> {
    return this.find(id);
  }

  /** Read back the row an auto-increment INSERT created: coerce the DB-assigned id (or use the preset one) and `find` it. */
  protected async findByInsertedId(
    dbAssignedId: number | bigint,
    presetId: TId | undefined,
  ): Promise<T> {
    const rowId = presetId ?? coerceScalarId<TId>(this.idType, dbAssignedId);
    const row = await this.find(rowId);
    if (!row) {
      throw new Error(`${this.entityName} insert: row id=${String(rowId)} not found after insert`);
    }
    return row;
  }

  private async spRows(procName: string, params: ReadonlyArray<unknown>): Promise<T[]> {
    const rows = await this.spClient!.invokeReturningRows<T>(procName, params);
    return rows.map((r) => this.fieldConverter.applyFrom(r));
  }

  private async queryRows(sql: string, params: ReadonlyArray<unknown>): Promise<T[]> {
    const rows = await this.datasource.query<T>(sql, params);
    return rows.map((r) => this.fieldConverter.applyFrom(r));
  }

  private mutationSet(data: Record<string, unknown>): {
    setClauses: string[];
    boundValues: unknown[];
  } {
    const entries: Array<[string, unknown]> = [...Object.entries(data), ['updated', new Date()]];
    return {
      setClauses: entries.map(
        ([k], i) => `${this.dialect.quoteId(k)} = ${this.dialect.placeholder(i)}`,
      ),
      boundValues: entries.map(([k, v]) => this.fieldConverter.applyTo(k, v)),
    };
  }

  private assertAffectedOne(affected: number, action: string): void {
    if (affected === 0) {
      throw new PreconditionFailedError(
        `optimistic concurrency conflict on inline ${action} for ${this.entityName}`,
      );
    }
    if (affected > 1) {
      throw new Error(
        `inline ${action} for ${this.entityName} affected ${affected} rows; expected exactly 1`,
      );
    }
  }

  async query<R = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<R[]> {
    return this.datasource.query<R>(sql, params);
  }

  private selectFrom(whereClause: string): string {
    const parts = [
      `SELECT * FROM ${this.tableName}`,
      whereClause,
      `ORDER BY ${this.dialect.quoteId('id')} ASC`,
    ];
    return parts.filter((p) => p.length > 0).join(' ');
  }

  async find(id: TId): Promise<T | null> {
    if (this.spClient) return (await this.spRows(`find_${this.entityName}`, [id]))[0] ?? null;
    const where = `WHERE ${this.dialect.quoteId('id')} = ${this.dialect.placeholder(0)}`;
    const rows = await this.queryRows(`SELECT * FROM ${this.tableName} ${where}`, [id]);
    return rows[0] ?? null;
  }

  async findAll(): Promise<T[]> {
    if (this.spClient) return this.spRows(`find_${this.entityNamePlural}`, []);
    return this.queryRows(this.selectFrom(''), []);
  }

  private selectWhere(predicate: string, params: ReadonlyArray<unknown>): Promise<T[]> {
    return this.queryRows(this.selectFrom(`WHERE ${predicate}`), params);
  }

  async findBy(column: string, value: unknown): Promise<T[]> {
    if (this.spClient) {
      return this.spRows(`find_${this.entityName}_by_${assertValidIdentifier(column)}`, [value]);
    }
    return this.selectWhere(`${this.dialect.quoteId(column)} = ${this.dialect.placeholder(0)}`, [
      this.fieldConverter.applyTo(column, value),
    ]);
  }

  async findIn(column: string, values: ReadonlyArray<unknown>): Promise<T[]> {
    if (values.length === 0) return [];
    return this.selectWhere(
      `${this.dialect.quoteId(column)} IN (${placeholderList(this.dialect.placeholder, values.length)})`,
      values.map((v) => this.fieldConverter.applyTo(column, v)),
    );
  }

  async add(data: Omit<T, StandardSystemKeys>): Promise<T> {
    const now = new Date();
    const record = data as Record<string, unknown>;
    if (this.spClient) return createViaSp<T, TId>(this, record, now);

    const { entries, presetId } = buildStandardInsert<TId>(record, {
      idType: this.idType,
      withUuidColumn: this.withUuidColumn,
      now,
    });
    const columns = entries.map(([k]) => this.dialect.quoteId(k));
    const values = entries.map(([k, v]) => this.fieldConverter.applyTo(k, v));

    const sql = `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholderList(this.dialect.placeholder, entries.length)})${this.dialect.insertReturning}`;
    const raw = await this.datasource.query<unknown>(sql, values);
    return this.resolveInsertedRow(raw, presetId);
  }

  async update(
    id: TId,
    data: Partial<Omit<T, StandardSystemKeys>>,
    opts?: { expectedUpdated?: string },
  ): Promise<T | null> {
    if (this.spClient) {
      return updateViaSp<T, TId>(this, { id, record: data as Record<string, unknown>, opts });
    }

    const { setClauses, boundValues } = this.mutationSet(data as Record<string, unknown>);
    const useInlineOcc = this.useOptimisticConcurrency && opts?.expectedUpdated !== undefined;
    const values = useInlineOcc
      ? [...boundValues, id, opts!.expectedUpdated]
      : [...boundValues, id];
    const whereTail = useInlineOcc
      ? `WHERE ${this.dialect.quoteId('id')} = ${this.dialect.placeholder(values.length - 2)} AND ${this.dialect.quoteId('updated')} = ${this.dialect.placeholder(values.length - 1)}`
      : `WHERE ${this.dialect.quoteId('id')} = ${this.dialect.placeholder(values.length - 1)}`;

    const sql = `UPDATE ${this.tableName} SET ${setClauses.join(', ')} ${whereTail}${this.dialect.mutationReturning}`;
    const raw = await this.datasource.query<unknown>(sql, values);
    const affected = this.affectedOf(raw);
    if (useInlineOcc) {
      this.assertAffectedOne(affected, 'update');
      return this.updatedRow(raw, id);
    }
    if (affected === 0) return null;
    return this.updatedRow(raw, id);
  }

  async delete(id: TId, opts?: { expectedUpdated?: string }): Promise<boolean> {
    if (this.spClient) return deleteViaSp<T, TId>(this, { id, opts });

    if (this.useOptimisticConcurrency && opts?.expectedUpdated !== undefined) {
      const sql = `DELETE FROM ${this.tableName} WHERE ${this.dialect.quoteId('id')} = ${this.dialect.placeholder(0)} AND ${this.dialect.quoteId('updated')} = ${this.dialect.placeholder(1)}${this.dialect.deleteReturning}`;
      const raw = await this.datasource.query<unknown>(sql, [id, opts.expectedUpdated]);
      this.assertAffectedOne(this.affectedOf(raw), 'delete');
      return true;
    }

    const sql = `DELETE FROM ${this.tableName} WHERE ${this.dialect.quoteId('id')} = ${this.dialect.placeholder(0)}${this.dialect.deleteReturning}`;
    const raw = await this.datasource.query<unknown>(sql, [id]);
    return this.affectedOf(raw) > 0;
  }

  async updateBy(
    column: string,
    value: unknown,
    data: Partial<Omit<T, StandardSystemKeys>>,
  ): Promise<T[]> {
    const { setClauses, boundValues } = this.mutationSet(data as Record<string, unknown>);
    const values = [...boundValues, this.fieldConverter.applyTo(column, value)];
    const sql = `UPDATE ${this.tableName} SET ${setClauses.join(', ')} WHERE ${this.dialect.quoteId(column)} = ${this.dialect.placeholder(values.length - 1)}`;
    return this.rewriteMatchedBy(column, value, { sql, values });
  }

  async deleteBy(column: string, value: unknown): Promise<number> {
    const sql = `DELETE FROM ${this.tableName} WHERE ${this.dialect.quoteId(column)} = ${this.dialect.placeholder(0)}${this.dialect.deleteReturning}`;
    const raw = await this.datasource.query<unknown>(sql, [
      this.fieldConverter.applyTo(column, value),
    ]);
    return this.affectedOf(raw);
  }

  private async rewriteMatchedBy(
    column: string,
    value: unknown,
    mutation: { sql: string; values: unknown[] },
  ): Promise<T[]> {
    const matched = await this.findBy(column, value);
    if (matched.length === 0) return [];
    await this.datasource.query(mutation.sql, mutation.values);
    return this.findIn('id', matched.map((r) => (r as { id: TId }).id) as ReadonlyArray<unknown>);
  }
}
