export type { IRepository } from './IRepository';
export type { ICrudRepository } from './ICrudRepository';
export { PrimaryKey } from './PrimaryKey';
export { EntityIdentity } from './EntityIdentity';
export type { IdentityValue } from './EntityIdentity';
export { PrimaryKeyService } from './PrimaryKeyService';
export type { PrimaryKeyRegistration } from './PrimaryKeyService';
export type { IPrimaryKeyService } from './IPrimaryKeyService';
export type { IStandardCrudRepository, StandardSystemKeys } from './IStandardCrudRepository';
export type { IDatasource } from './IDatasource';
export type { ISetup } from './ISetup';

export { pathExists } from './pathExists';

export { buildRepoForBackend } from './buildRepoForBackend';
export type { DatabaseBackendType, DatabaseConnection } from './buildRepoForBackend';

export { InMemoryDatasource } from './inmemory/InMemoryDatasource';
export type { InMemoryTable } from './inmemory/InMemoryDatasource';
export { InMemoryCrudRepository } from './inmemory/InMemoryCrudRepository';

export { SqliteSetup } from './sqlite/SqliteSetup';
export type { SqliteSetupOptions } from './sqlite/SqliteSetup';
export { SqliteDatasource } from './sqlite/SqliteDatasource';
export type { SqliteDatasourceOptions } from './sqlite/SqliteDatasource';
export { SqliteCrudRepository } from './sqlite/SqliteCrudRepository';
export { SqliteStandardRepository } from './sqlite/SqliteStandardRepository';

export { PostgresSetup } from './postgres/PostgresSetup';
export type { PostgresSetupOptions } from './postgres/PostgresSetup';
export { PostgresDatasource } from './postgres/PostgresDatasource';
export type { PostgresDatasourceOptions } from './postgres/PostgresDatasource';
export { PostgresCrudRepository } from './postgres/PostgresCrudRepository';
export { PostgresStandardRepository } from './postgres/PostgresStandardRepository';

export { MysqlSetup } from './mysql/MysqlSetup';
export type { MysqlSetupOptions } from './mysql/MysqlSetup';
export { MysqlDatasource } from './mysql/MysqlDatasource';
export type { MysqlDatasourceOptions } from './mysql/MysqlDatasource';
export { MysqlCrudRepository } from './mysql/MysqlCrudRepository';
export { MysqlStandardRepository } from './mysql/MysqlStandardRepository';
