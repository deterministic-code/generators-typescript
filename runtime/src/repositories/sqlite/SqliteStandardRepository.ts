import { quoteIdentifier } from '../sqlIdentifier';
import { AbstractStandardRepository, type StandardDialectConfig } from '../standardRepositoryBase';
import { type StandardRepositoryOptions } from '../standardFieldConverting';
import type { StandardSpClient } from '../standardSpWriter';
import { SqliteDatasource } from './SqliteDatasource';

export type SqliteStandardRepositoryOptions = StandardRepositoryOptions;

const SQLITE_DIALECT: StandardDialectConfig = {
  converterDialect: 'sqlite',
  quoteId: quoteIdentifier,
  placeholder: () => '?',
  makeSpClient: (): StandardSpClient => {
    throw new Error('sqlite does not support stored procedures');
  },
  insertReturning: '',
  mutationReturning: '',
  deleteReturning: '',
};

export class SqliteStandardRepository<
  T extends { id: TId },
  TId = number,
> extends AbstractStandardRepository<T, TId> {
  constructor(
    datasource: SqliteDatasource,
    tableName: string,
    options: SqliteStandardRepositoryOptions,
  ) {
    super({ datasource, dialect: SQLITE_DIALECT }, tableName, options);
  }

  protected resolveInsertedRow(raw: unknown[], presetId: TId | undefined): Promise<T> {
    return this.findByInsertedId(
      (raw[0] as { lastInsertRowid: number | bigint }).lastInsertRowid,
      presetId,
    );
  }

  protected affectedOf(raw: unknown[]): number {
    return (raw[0] as { changes: number }).changes;
  }
}
