import type { IDataSourceMiddleware } from '../middleware/IDataSourceMiddleware';
import type { ITypeFieldConverter } from '../converters/ITypeFieldConverter';
import type { ICrudRepository } from './ICrudRepository';
import type { IPrimaryKeyService } from './IPrimaryKeyService';
import type { IDatasourceNaming } from '@deterministic-code/generators-common/datasource-naming';
import type { EntityFieldMap } from './parseFieldMappings';
import { InMemoryCrudRepository } from './inmemory/InMemoryCrudRepository';
import { InMemoryDatasource } from './inmemory/InMemoryDatasource';
import { MysqlCrudRepository } from './mysql/MysqlCrudRepository';
import type { MysqlDatasource } from './mysql/MysqlDatasource';
import { OracleCrudRepository } from './oracle/OracleCrudRepository';
import type { OracleDatasource } from './oracle/OracleDatasource';
import { PostgresCrudRepository } from './postgres/PostgresCrudRepository';
import type { PostgresDatasource } from './postgres/PostgresDatasource';
import { SqliteCrudRepository } from './sqlite/SqliteCrudRepository';
import type { SqliteDatasource } from './sqlite/SqliteDatasource';
import { SqlserverCrudRepository } from './sqlserver/SqlserverCrudRepository';
import type { SqlserverDatasource } from './sqlserver/SqlserverDatasource';

export type DatabaseBackendType =
  | 'postgres'
  | 'sqlite'
  | 'mysql'
  | 'sqlserver'
  | 'oracle'
  | 'memory';

export interface DatabaseConnection {
  type: DatabaseBackendType;
  datasource?:
    | PostgresDatasource
    | SqliteDatasource
    | MysqlDatasource
    | SqlserverDatasource
    | OracleDatasource
    | InMemoryDatasource;
  middlewares?: readonly IDataSourceMiddleware[];
  close(): Promise<void>;
}

export interface BuildRepoOptions {
  hasStandardColumns?: boolean;
  columnTypes?: Readonly<Record<string, string>>;
  withUuidColumn?: boolean;
  /** The entity this repository serves — resolves its primary key through {@link primaryKeys}. */
  entityName: string;
  /** The one authority that resolves each entity's primary key (column + id_type), injected from the composition root. */
  primaryKeys: IPrimaryKeyService;
  fieldMappings?: EntityFieldMap;
  naming: IDatasourceNaming;
  converters?: ReadonlyMap<string, ITypeFieldConverter>;
  fieldConverters?: ReadonlyMap<string, ITypeFieldConverter>;
}

export function buildRepoForBackend<T extends { id: number | string } = { id: number }>(
  conn: DatabaseConnection,
  tableName: string,
  options: BuildRepoOptions,
): ICrudRepository<T> {
  const middlewares = conn.middlewares ?? [];
  type LegacyT = T & { id: number };
  const sqlOptions = {
    middlewares,
    columnTypes: options.columnTypes,
    entityName: options.entityName,
    primaryKeys: options.primaryKeys,
    fieldMappings: options.fieldMappings,
    naming: options.naming,
    converters: options.converters,
    fieldConverters: options.fieldConverters,
    ...(options.withUuidColumn !== undefined && {
      withUuidColumn: options.withUuidColumn,
    }),
  };
  switch (conn.type) {
    case 'postgres':
      return new PostgresCrudRepository<T>(
        conn.datasource as PostgresDatasource,
        tableName,
        sqlOptions,
      ) as ICrudRepository<T>;
    case 'sqlite':
      return new SqliteCrudRepository<T>(
        conn.datasource as SqliteDatasource,
        tableName,
        sqlOptions,
      ) as ICrudRepository<T>;
    case 'mysql':
      return new MysqlCrudRepository<T>(
        conn.datasource as MysqlDatasource,
        tableName,
        sqlOptions,
      ) as ICrudRepository<T>;
    case 'sqlserver':
      return new SqlserverCrudRepository<LegacyT>(
        conn.datasource as SqlserverDatasource,
        tableName,
        { middlewares, entityName: options.entityName, primaryKeys: options.primaryKeys },
      ) as unknown as ICrudRepository<T>;
    case 'oracle':
      return new OracleCrudRepository<LegacyT>(conn.datasource as OracleDatasource, tableName, {
        middlewares,
        entityName: options.entityName,
        primaryKeys: options.primaryKeys,
      }) as unknown as ICrudRepository<T>;
    case 'memory':
      const ds = (conn.datasource as InMemoryDatasource) ?? new InMemoryDatasource();
      return new InMemoryCrudRepository<LegacyT>(ds, tableName, {
        middlewares,
        hasStandardColumns: options.hasStandardColumns ?? true,
        entityName: options.entityName,
        primaryKeys: options.primaryKeys,
      }) as unknown as ICrudRepository<T>;
  }
}
