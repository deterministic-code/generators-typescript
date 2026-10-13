import type { DatabaseBackendType } from '../app/database';

export interface IDataSourceMiddleware {
  beforeQuery(
    provider: DatabaseBackendType,
    query: string,
    params?: ReadonlyArray<unknown>,
  ):
    | void
    | { query: string; params?: ReadonlyArray<unknown> }
    | Promise<void | { query: string; params?: ReadonlyArray<unknown> }>;

  afterQuery(
    provider: DatabaseBackendType,
    query: string,
    params: ReadonlyArray<unknown> | undefined,
    results: ReadonlyArray<unknown>,
    elapsedMs: number,
    error?: unknown,
  ): void | Promise<void>;
}
