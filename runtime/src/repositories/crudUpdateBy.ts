/** Turn the `SET` entries into the dialect's `UPDATE` SQL and bound values. */
type BuildUpdate = (entries: Array<[string, unknown]>) => { sql: string; values: unknown[] };

/** The `column = value` match plus the partial row to write, shared by both `updateBy` skeletons. */
export interface UpdateByRequest {
  column: string;
  value: unknown;
  data: Record<string, unknown>;
  buildUpdate: BuildUpdate;
}

/** What {@link updateByMatched} needs from a repository: the two reads, the raw query runner, and the primary key column that identifies the touched rows. */
export interface UpdateByHost<TRow> {
  findBy(column: string, value: unknown): Promise<TRow[]>;
  find(id: unknown): Promise<TRow | null>;
  findIn(column: string, values: ReadonlyArray<unknown>): Promise<TRow[]>;
  runUpdate(sql: string, values: unknown[]): Promise<unknown>;
  readonly primaryKeyColumn: string;
  readonly primaryKey: {
    isComposite: boolean;
    fromRow(row: Record<string, unknown>): unknown;
  };
}

function updateSqlFor(req: UpdateByRequest) {
  const entries = Object.entries(req.data);
  return entries.length === 0 ? null : req.buildUpdate(entries);
}

/**
 * The dialect-agnostic `updateBy` skeleton: read the rows matching `column = value`,
 * short-circuit when nothing matches or there is nothing to set, run the dialect's
 * UPDATE, then re-read the touched rows by primary key so the caller sees post-update
 * state. `buildUpdate` owns the only dialect-specific part (the SQL + bound values).
 */
export async function updateByMatched<TRow>(
  host: UpdateByHost<TRow>,
  req: UpdateByRequest,
): Promise<TRow[]> {
  const matched = await host.findBy(req.column, req.value);
  if (matched.length === 0) return [];

  const mutation = updateSqlFor(req);
  if (!mutation) return matched;
  await host.runUpdate(mutation.sql, mutation.values);

  if (host.primaryKey.isComposite) {
    const out: TRow[] = [];
    for (const row of matched) {
      const found = await host.find(host.primaryKey.fromRow(row as Record<string, unknown>));
      if (found !== null) out.push(found);
    }
    return out;
  }
  const pks = matched.map((r) => (r as Record<string, unknown>)[host.primaryKeyColumn]);
  return host.findIn(host.primaryKeyColumn, pks);
}

/**
 * The `updateBy` skeleton for dialects that return the mutated rows inline (Postgres
 * `RETURNING *`): nothing to set is a no-op read; otherwise run the UPDATE and hand back
 * the returned rows. `readRows` matches the current rows when there is nothing to change.
 */
export async function updateByReturning<TRow>(
  host: {
    readRows: (column: string, value: unknown) => Promise<TRow[]>;
    runReturning: (sql: string, values: unknown[]) => Promise<TRow[]>;
  },
  req: UpdateByRequest,
): Promise<TRow[]> {
  const mutation = updateSqlFor(req);
  if (!mutation) return host.readRows(req.column, req.value);
  return host.runReturning(mutation.sql, mutation.values);
}
