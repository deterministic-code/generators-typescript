export type DatabaseBackendType =
  | 'postgres'
  | 'sqlite'
  | 'mysql'
  | 'sqlserver'
  | 'oracle'
  | 'memory';

export interface DatabaseConnection {
  type: DatabaseBackendType;
  datasource?: unknown;
  middlewares?: readonly unknown[];
  close(): Promise<void>;
}
