import { randomUUID } from 'node:crypto';
import {
  IStandardCrudRepository,
  type StandardSystemKeys,
} from '../IStandardCrudRepository';
import type { IPrimaryKeyService } from '../IPrimaryKeyService';
import type { StandardIdType } from '../standardFieldConverting';
import { quoteIdentifier } from '../sqlIdentifier';
import type { OracleDatasource } from './OracleDatasource';
import { DatasourceBackedRepository } from '../PrimaryKeyBearingRepository';

export interface OracleStandardRepositoryOptions {
  entityName: string;
  primaryKeys: IPrimaryKeyService;
  withUuidColumn?: boolean;
}

export class OracleStandardRepository<
  T extends { id: TId },
  TId = number,
>
  extends DatasourceBackedRepository<OracleDatasource>
  implements IStandardCrudRepository<T, TId>
{
  protected readonly tableName: string;
  protected readonly idType: StandardIdType;
  protected readonly withUuidColumn: boolean;

  constructor(datasource: OracleDatasource, tableName: string, options: OracleStandardRepositoryOptions) {
    super(datasource, options.entityName, options.primaryKeys);
    this.tableName = quoteIdentifier(tableName);
    this.idType = this.primaryKey.idType;
    this.withUuidColumn = options.withUuidColumn ?? true;
  }

  async find(id: TId): Promise<T | null> {
    const rows = await this.datasource.query<T>(`SELECT * FROM ${this.tableName} WHERE "id" = :1`, [
      id,
    ]);
    return rows[0] ?? null;
  }

  async findAll(): Promise<T[]> {
    return this.datasource.query<T>(`SELECT * FROM ${this.tableName} ORDER BY "id" ASC`);
  }

  async findBy(column: string, value: unknown): Promise<T[]> {
    return this.datasource.query<T>(
      `SELECT * FROM ${this.tableName} WHERE ${quoteIdentifier(column)} = :1 ORDER BY "id" ASC`,
      [value],
    );
  }

  async findIn(column: string, values: ReadonlyArray<unknown>): Promise<T[]> {
    if (values.length === 0) return [];
    const placeholders = values.map((_, i) => `:${i + 1}`).join(', ');
    return this.datasource.query<T>(
      `SELECT * FROM ${this.tableName} WHERE ${quoteIdentifier(column)} IN (${placeholders}) ORDER BY "id" ASC`,
      values,
    );
  }

  async add(data: Omit<T, StandardSystemKeys>): Promise<T> {
    const now = new Date().toISOString();
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

    const columns = entries.map(([k]) => quoteIdentifier(k));
    const placeholders = entries.map((_, i) => `:${i + 1}`);
    const values = entries.map(([, v]) => v);

    const sql = `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING "id" INTO :${entries.length + 1}`;
    const returnedId = await this.datasource.executeReturningId(sql, values);
    const row = await this.find(
      this.idType === 'string' || this.idType === 'uuid' ? id! : (returnedId as TId),
    );
    if (!row) throw new Error(`OracleStandardRepository.add(): inserted row not found`);
    return row;
  }

  async update(
    id: TId,
    data: Partial<Omit<T, StandardSystemKeys>>,
  ): Promise<T | null> {
    const now = new Date().toISOString();
    const entries: Array<[string, unknown]> = [
      ...Object.entries(data as Record<string, unknown>),
      ['updated', now],
    ];
    const setClauses = entries.map(([k], i) => `${quoteIdentifier(k)} = :${i + 1}`);
    const values = [...entries.map(([, v]) => v), id];

    const sql = `UPDATE ${this.tableName} SET ${setClauses.join(', ')} WHERE "id" = :${values.length}`;
    const [result] = await this.datasource.query<{ rowsAffected: number }>(sql, values);
    if (result.rowsAffected === 0) return null;
    return this.find(id);
  }

  async delete(id: TId): Promise<boolean> {
    const [result] = await this.datasource.query<{ rowsAffected: number }>(
      `DELETE FROM ${this.tableName} WHERE "id" = :1`,
      [id],
    );
    return result.rowsAffected > 0;
  }

  async updateBy(
    column: string,
    value: unknown,
    data: Partial<Omit<T, StandardSystemKeys>>,
  ): Promise<T[]> {
    const matched = await this.findBy(column, value);
    if (matched.length === 0) return [];

    const now = new Date().toISOString();
    const entries: Array<[string, unknown]> = [
      ...Object.entries(data as Record<string, unknown>),
      ['updated', now],
    ];
    const setClauses = entries.map(([k], i) => `${quoteIdentifier(k)} = :${i + 1}`);
    const values = [...entries.map(([, v]) => v), value];

    const sql = `UPDATE ${this.tableName} SET ${setClauses.join(', ')} WHERE ${quoteIdentifier(column)} = :${values.length}`;
    await this.datasource.query(sql, values);

    const ids = matched.map((r) => (r as { id: TId }).id);
    return this.findIn('id', ids as ReadonlyArray<unknown>);
  }

  async deleteBy(column: string, value: unknown): Promise<number> {
    const [result] = await this.datasource.query<{ rowsAffected: number }>(
      `DELETE FROM ${this.tableName} WHERE ${quoteIdentifier(column)} = :1`,
      [value],
    );
    return result.rowsAffected;
  }
}
