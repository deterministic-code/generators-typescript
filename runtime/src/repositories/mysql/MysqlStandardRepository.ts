import { quoteMysqlIdentifier } from '../sqlIdentifier';
import { AbstractStandardRepository, type StandardDialectConfig } from '../standardRepositoryBase';
import { type StandardRepositoryOptions } from '../standardFieldConverting';
import type { StandardSpClient } from '../standardSpWriter';
import { IDatasource } from '../IDatasource';
import { MysqlDatasource } from './MysqlDatasource';
import { MysqlStoredProcedureClient } from './MysqlStoredProcedureClient';

export type MysqlStandardRepositoryOptions = StandardRepositoryOptions;

const MYSQL_DIALECT: StandardDialectConfig = {
  converterDialect: 'mysql',
  quoteId: quoteMysqlIdentifier,
  placeholder: () => '?',
  makeSpClient: (ds: IDatasource): StandardSpClient =>
    new MysqlStoredProcedureClient(ds as MysqlDatasource),
  insertReturning: '',
  mutationReturning: '',
  deleteReturning: '',
};

export class MysqlStandardRepository<
  T extends { id: TId },
  TId = number,
> extends AbstractStandardRepository<T, TId> {
  constructor(
    datasource: MysqlDatasource,
    tableName: string,
    options: MysqlStandardRepositoryOptions,
  ) {
    super({ datasource, dialect: MYSQL_DIALECT }, tableName, options);
  }

  protected resolveInsertedRow(raw: unknown[], presetId: TId | undefined): Promise<T> {
    return this.findByInsertedId((raw[0] as { insertId: number }).insertId, presetId);
  }

  protected affectedOf(raw: unknown[]): number {
    return (raw[0] as { affectedRows: number }).affectedRows;
  }
}
