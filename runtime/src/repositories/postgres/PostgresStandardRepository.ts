import { quoteIdentifier } from '../sqlIdentifier';
import { AbstractStandardRepository, type StandardDialectConfig } from '../standardRepositoryBase';
import { type StandardRepositoryOptions } from '../standardFieldConverting';
import type { StandardSpClient } from '../standardSpWriter';
import { IDatasource } from '../IDatasource';
import { PostgresDatasource } from './PostgresDatasource';
import { PostgresStoredProcedureClient } from './PostgresStoredProcedureClient';

export type PostgresStandardRepositoryOptions = StandardRepositoryOptions;

const POSTGRES_DIALECT: StandardDialectConfig = {
  converterDialect: 'postgres',
  quoteId: quoteIdentifier,
  placeholder: (i: number) => `$${i + 1}`,
  makeSpClient: (ds: IDatasource): StandardSpClient =>
    new PostgresStoredProcedureClient(ds as PostgresDatasource),
  insertReturning: ' RETURNING *',
  mutationReturning: ' RETURNING *',
  deleteReturning: ' RETURNING "id"',
};

export class PostgresStandardRepository<
  T extends { id: TId },
  TId = number,
> extends AbstractStandardRepository<T, TId> {
  constructor(
    datasource: PostgresDatasource,
    tableName: string,
    options: PostgresStandardRepositoryOptions,
  ) {
    super({ datasource, dialect: POSTGRES_DIALECT }, tableName, options);
  }

  protected async resolveInsertedRow(raw: unknown[]): Promise<T> {
    return this.fieldConverter.applyFrom((raw as T[])[0]);
  }

  protected affectedOf(raw: unknown[]): number {
    return raw.length;
  }

  protected async updatedRow(raw: unknown[]): Promise<T | null> {
    const row = (raw as T[])[0];
    return row ? this.fieldConverter.applyFrom(row) : null;
  }
}
