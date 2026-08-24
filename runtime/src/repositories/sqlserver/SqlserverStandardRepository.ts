import { randomUUID } from 'node:crypto';
import { PreconditionFailedError } from '../../errors/AppError';
import {
  IStandardCrudRepository,
  type StandardSystemKeys,
} from '../IStandardCrudRepository';
import type { IPrimaryKeyService } from '../IPrimaryKeyService';
import type { StandardIdType } from '../standardFieldConverting';
import { assertValidIdentifier, quoteSqlserverIdentifier } from '../sqlIdentifier';
import type { SqlserverDatasource } from './SqlserverDatasource';
import { SqlserverStoredProcedureClient } from './SqlserverStoredProcedureClient';
import { DatasourceBackedRepository } from '../PrimaryKeyBearingRepository';

export interface SqlserverStandardRepositoryOptions {
  entityName: string;
  primaryKeys: IPrimaryKeyService;
  withUuidColumn?: boolean;
  useStoredProcedures?: boolean;
  useOptimisticConcurrency?: boolean;
  entityNamePlural?: string;
}

export class SqlserverStandardRepository<
  T extends { id: TId },
  TId = number,
>
  extends DatasourceBackedRepository<SqlserverDatasource>
  implements IStandardCrudRepository<T, TId>
{
  protected readonly tableName: string;
  protected readonly idType: StandardIdType;
  protected readonly withUuidColumn: boolean;
  protected readonly useStoredProcedures: boolean;
  protected readonly useOptimisticConcurrency: boolean;
  protected readonly entityNamePlural: string;
  protected readonly spClient: SqlserverStoredProcedureClient | null;

  constructor(datasource: SqlserverDatasource, tableName: string, options: SqlserverStandardRepositoryOptions) {
    super(datasource, assertValidIdentifier(options.entityName), options.primaryKeys);
    this.useStoredProcedures = options.useStoredProcedures === true;
    this.useOptimisticConcurrency = options.useOptimisticConcurrency === true;
    this.tableName = quoteSqlserverIdentifier(tableName);
    this.idType = this.primaryKey.idType;
    this.withUuidColumn = options.withUuidColumn ?? true;
    this.entityNamePlural = assertValidIdentifier(
      options?.entityNamePlural ?? `${this.entityName}s`,
    );
    this.spClient = this.useStoredProcedures
      ? new SqlserverStoredProcedureClient(datasource)
      : null;
  }

  async find(id: TId): Promise<T | null> {
    if (this.spClient) {
      const rows = await this.spClient.invokeReturningRows<T>(`find_${this.entityName}`, [id]);
      return rows[0] ?? null;
    }
    const rows = await this.datasource.query<T>(
      `SELECT * FROM ${this.tableName} WHERE [id] = @p1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findAll(): Promise<T[]> {
    if (this.spClient) {
      return this.spClient.invokeReturningRows<T>(`find_${this.entityNamePlural}`, []);
    }
    return this.datasource.query<T>(`SELECT * FROM ${this.tableName} ORDER BY [id] ASC`);
  }

  async findBy(column: string, value: unknown): Promise<T[]> {
    if (this.spClient) {
      const procName = `find_${this.entityName}_by_${assertValidIdentifier(column)}`;
      return this.spClient.invokeReturningRows<T>(procName, [value]);
    }
    return this.datasource.query<T>(
      `SELECT * FROM ${this.tableName} WHERE ${quoteSqlserverIdentifier(column)} = @p1 ORDER BY [id] ASC`,
      [value],
    );
  }

  async findIn(column: string, values: ReadonlyArray<unknown>): Promise<T[]> {
    if (values.length === 0) return [];
    const placeholders = values.map((_, i) => `@p${i + 1}`).join(', ');
    return this.datasource.query<T>(
      `SELECT * FROM ${this.tableName} WHERE ${quoteSqlserverIdentifier(column)} IN (${placeholders}) ORDER BY [id] ASC`,
      values,
    );
  }

  async add(data: Omit<T, StandardSystemKeys>): Promise<T> {
    const now = new Date().toISOString();

    if (this.spClient) {
      const record = data as Record<string, unknown>;
      const uuid = (record['uuid'] as string | undefined) ?? randomUUID();
      const newId = await this.spClient.invokeReturningId(`create_${this.entityName}`, [
        uuid,
        record['name'] ?? null,
        record['email'] ?? null,
        now,
        now,
      ]);
      const row = await this.find(Number(newId) as unknown as TId);
      if (!row) {
        throw new Error(
          `SqlserverStandardRepository.add: row id=${newId} not found after create_${this.entityName}`,
        );
      }
      return row;
    }

    let id: TId | undefined;

    if (this.idType === 'string') {
      const dataRecord = data as Record<string, unknown>;
      if (dataRecord['id'] === undefined) {
        throw new Error("Caller-supplied id required when idType='string'");
      }
      id = dataRecord['id'] as TId;
    } else if (this.idType === 'uuid') {
      const dataRecord = data as Record<string, unknown>;
      id = (dataRecord['id'] ?? randomUUID()) as TId;
    }

    const entries: Array<[string, unknown]> = [...Object.entries(data as Record<string, unknown>)];

    if (this.idType === 'string' || this.idType === 'uuid') {
      entries.unshift(['id', id]);
    }

    if (this.withUuidColumn) {
      entries.push(['uuid', randomUUID()]);
    }

    entries.push(['created', now], ['updated', now]);

    const columns = entries.map(([k]) => quoteSqlserverIdentifier(k));
    const placeholders = entries.map((_, i) => `@p${i + 1}`);
    const values = entries.map(([, v]) => v);

    const sql = `INSERT INTO ${this.tableName} (${columns.join(', ')}) OUTPUT INSERTED.* VALUES (${placeholders.join(', ')})`;
    const rows = await this.datasource.query<T>(sql, values);
    return rows[0];
  }

  async update(
    id: TId,
    data: Partial<Omit<T, StandardSystemKeys>>,
    opts?: { expectedUpdated?: string },
  ): Promise<T | null> {
    const now = new Date().toISOString();
    const record = data as Record<string, unknown>;

    // Procs accept full state (no COALESCE), so read-then-merge keeps a partial `data` from nulling untouched fields.
    function mergedField(key: string, current: Record<string, unknown>): unknown {
      if (key in record && record[key] !== undefined) return record[key];
      return current[key] ?? null;
    }

    if (this.spClient) {
      const current = (await this.find(id)) as Record<string, unknown> | null;
      if (!current) return null;
      const mergedName = mergedField('name', current);
      const mergedEmail = mergedField('email', current);

      if (this.useOptimisticConcurrency && opts?.expectedUpdated !== undefined) {
        const affected = await this.spClient.invokeReturningAffected(
          `update_${this.entityName}_optimistic_concurrency`,
          [id, opts.expectedUpdated, mergedName, mergedEmail, now],
        );
        if (affected !== 1) {
          throw new PreconditionFailedError(
            `optimistic concurrency conflict on update_${this.entityName}_optimistic_concurrency`,
          );
        }
        return this.find(id);
      }

      const affected = await this.spClient.invokeReturningAffected(`update_${this.entityName}`, [
        id,
        mergedName,
        mergedEmail,
        now,
      ]);
      if (affected === 0) return null;
      return this.find(id);
    }

    return this.updateInline(record, id, opts);
  }

  private async updateInline(
    record: Record<string, unknown>,
    id: TId,
    opts: { expectedUpdated?: string } | undefined,
  ): Promise<T | null> {
    const now = new Date().toISOString();
    const entries: Array<[string, unknown]> = [...Object.entries(record), ['updated', now]];
    const setClauses = entries.map(([k], i) => `${quoteSqlserverIdentifier(k)} = @p${i + 1}`);
    const useInlineOcc = this.useOptimisticConcurrency && opts?.expectedUpdated !== undefined;
    const values = useInlineOcc
      ? [...entries.map(([, v]) => v), id, opts!.expectedUpdated]
      : [...entries.map(([, v]) => v), id];
    const whereTail = useInlineOcc
      ? `WHERE [id] = @p${values.length - 1} AND [updated] = @p${values.length}`
      : `WHERE [id] = @p${values.length}`;

    const sql = `UPDATE ${this.tableName} SET ${setClauses.join(', ')} OUTPUT INSERTED.* ${whereTail}`;
    const rows = await this.datasource.query<T>(sql, values);
    if (useInlineOcc) {
      if (rows.length === 0) {
        throw new PreconditionFailedError(
          `optimistic concurrency conflict on inline update for ${this.entityName}`,
        );
      }
      if (rows.length > 1) {
        throw new Error(
          `inline update for ${this.entityName} affected ${rows.length} rows; expected exactly 1`,
        );
      }
      return rows[0];
    }
    return rows[0] ?? null;
  }

  async delete(id: TId, opts?: { expectedUpdated?: string }): Promise<boolean> {
    if (this.spClient && this.useOptimisticConcurrency && opts?.expectedUpdated !== undefined) {
      const affected = await this.spClient.invokeReturningAffected(
        `delete_${this.entityName}_optimistic_concurrency`,
        [id, opts.expectedUpdated],
      );
      if (affected !== 1) {
        throw new PreconditionFailedError(
          `optimistic concurrency conflict on delete_${this.entityName}_optimistic_concurrency`,
        );
      }
      return true;
    }

    if (this.spClient) {
      const affected = await this.spClient.invokeReturningAffected(`delete_${this.entityName}`, [
        id,
      ]);
      return affected > 0;
    }

    if (this.useOptimisticConcurrency && opts?.expectedUpdated !== undefined) {
      const sql = `DELETE FROM ${this.tableName} OUTPUT DELETED.[id] WHERE [id] = @p1 AND [updated] = @p2`;
      const rows = await this.datasource.query<{ id: TId }>(sql, [id, opts.expectedUpdated]);
      if (rows.length === 0) {
        throw new PreconditionFailedError(
          `optimistic concurrency conflict on inline delete for ${this.entityName}`,
        );
      }
      if (rows.length > 1) {
        throw new Error(
          `inline delete for ${this.entityName} affected ${rows.length} rows; expected exactly 1`,
        );
      }
      return true;
    }

    const sql = `DELETE FROM ${this.tableName} OUTPUT DELETED.[id] WHERE [id] = @p1`;
    const rows = await this.datasource.query<{ id: TId }>(sql, [id]);
    return rows.length > 0;
  }

  async updateBy(
    column: string,
    value: unknown,
    data: Partial<Omit<T, StandardSystemKeys>>,
  ): Promise<T[]> {
    const now = new Date().toISOString();
    const entries: Array<[string, unknown]> = [
      ...Object.entries(data as Record<string, unknown>),
      ['updated', now],
    ];
    const setClauses = entries.map(([k], i) => `${quoteSqlserverIdentifier(k)} = @p${i + 1}`);
    const values = [...entries.map(([, v]) => v), value];

    const sql = `UPDATE ${this.tableName} SET ${setClauses.join(', ')} OUTPUT INSERTED.* WHERE ${quoteSqlserverIdentifier(column)} = @p${values.length}`;
    return this.datasource.query<T>(sql, values);
  }

  async deleteBy(column: string, value: unknown): Promise<number> {
    const sql = `DELETE FROM ${this.tableName} OUTPUT DELETED.[id] WHERE ${quoteSqlserverIdentifier(column)} = @p1`;
    const rows = await this.datasource.query<{ id: TId }>(sql, [value]);
    return rows.length;
  }
}
