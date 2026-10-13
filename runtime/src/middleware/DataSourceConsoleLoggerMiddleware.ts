import type { DatabaseBackendType } from '../app/database';
import type { IDataSourceMiddleware } from './IDataSourceMiddleware';
import { errorMessage, formatElapsedMs, formatTraceLine } from './traceFormat';

const SQL_MAX_CHARS = 1024;

// The trace format puts SQL inside `[...]`, so ']' is replaced and length capped to keep the boundary parseable.
function renderSql(query: string): string {
  const collapsed = query.replace(/\s+/g, ' ').trim().replace(/]/g, ')');
  if (collapsed.length <= SQL_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, SQL_MAX_CHARS - 1)}…`;
}

export class DataSourceConsoleLoggerMiddleware implements IDataSourceMiddleware {
  beforeQuery(
    _provider: DatabaseBackendType,
    query: string,
    _params?: ReadonlyArray<unknown>,
  ): void {
    console.log(formatTraceLine(new Date().toISOString(), 'datasource', 'Start', renderSql(query)));
  }

  afterQuery(
    _provider: DatabaseBackendType,
    query: string,
    _params: ReadonlyArray<unknown> | undefined,
    _results: ReadonlyArray<unknown>,
    elapsedMs: number,
    error?: unknown,
  ): void {
    const sql = renderSql(query);
    const elapsed = formatElapsedMs(elapsedMs);
    if (error !== undefined) {
      console.log(
        formatTraceLine(
          new Date().toISOString(),
          'datasource',
          'Error',
          sql,
          `${errorMessage(error)} ${elapsed}`,
        ),
      );
      return;
    }
    console.log(formatTraceLine(new Date().toISOString(), 'datasource', 'Finish', sql, elapsed));
  }
}
