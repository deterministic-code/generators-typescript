import type { DatabaseConnection, DatabaseBackendType } from './database';

export type SupportedBackend = DatabaseBackendType;
export type SqliteHandle = unknown;

const VALID_BACKENDS: readonly SupportedBackend[] = [
  'sqlite',
  'postgres',
  'mysql',
  'sqlserver',
  'oracle',
  'memory',
];

export interface ConnectDatabaseOptions {
  backend?: SupportedBackend;
  databaseUrl?: string;
  sqliteFile?: string;
  onSqliteFirstOpen?: (db: SqliteHandle) => void | Promise<void>;
  isSqliteFresh?: (sqliteFile: string) => boolean | Promise<boolean>;
  migrationsDir?: string;
  seedFile?: string;
}

function resolveBackend(explicit: SupportedBackend | undefined): SupportedBackend {
  if (explicit) return explicit;
  const raw = process.env.DATABASE_BACKEND;
  if (!raw) return 'memory';
  if (!(VALID_BACKENDS as readonly string[]).includes(raw)) {
    throw new Error(
      `DATABASE_BACKEND=${raw} is not a supported backend. Valid values: ${VALID_BACKENDS.join(', ')}.`,
    );
  }
  return raw as SupportedBackend;
}

/** Persistence now lives in @datasources/core. This only returns a handle the app can close. */
export async function connectDatabase(
  options: ConnectDatabaseOptions = {},
): Promise<DatabaseConnection> {
  const backend = resolveBackend(options.backend);
  return { type: backend, close: () => Promise.resolve() };
}
