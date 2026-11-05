import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface SavedItem {
  deterministic_type_name?: string;
  version: number;
  text?: string;
}

type FetchLike = typeof fetch;
type Extras = Record<string, unknown>;

export interface Include {
  file?: string;
  id?: string;
  uuid?: string;
  user_id?: number;
  name?: string;
}

export interface LoaderCtx {
  baseDir?: string;
}

interface CombinedLoaderConfig {
  itemType: string;
  fileExtras?: (dir: string) => Extras | Promise<Extras>;
  idExtras?: (body: unknown) => Extras;
}

/** The text of the highest-`version` saved item whose `deterministic_type_name` matches, or null. */
export function latestItemText(body: unknown, typeName: string): string | null {
  const raw = (body as { items?: unknown } | null | undefined)?.items;
  const items: SavedItem[] = Array.isArray(raw) ? raw : [];
  let best: SavedItem | null = null;
  for (const item of items) {
    if (item?.deterministic_type_name !== typeName) continue;
    if (!best || item.version > best.version) best = item;
  }
  return best?.text ?? null;
}

/** A human-readable label for an include reference, for apiUrl/HTTP error messages. */
function refLabel(include: Include): string {
  if (include.uuid !== undefined) return `uuid '${include.uuid}'`;
  if (include.user_id !== undefined && include.name !== undefined) {
    return `'${include.user_id}/${include.name}'`;
  }
  return `id '${include.id}'`;
}

/** The `/api/deterministic-all` endpoint for an include reference: `by-uuid/…` and `by-user/…/name/…` are the portable forms; a bare numeric id keeps the original `/api/deterministic-all/{id}` path. */
function applicationPath(apiUrl: string, include: Include): string {
  if (include.uuid !== undefined) {
    return `${apiUrl}/api/deterministic-all/by-uuid/${include.uuid}`;
  }
  if (include.user_id !== undefined && include.name !== undefined) {
    return `${apiUrl}/api/deterministic-all/by-user/${include.user_id}/name/${encodeURIComponent(include.name)}`;
  }
  return `${apiUrl}/api/deterministic-all/${include.id}`;
}

/** Fetch a saved backend's `/api/deterministic-all` body for any reference form; throws on a missing apiUrl or a non-ok response. */
async function fetchApplicationBody(
  apiUrl: string | null,
  include: Include,
  fetchImpl: FetchLike,
): Promise<unknown> {
  if (!apiUrl) {
    throw new Error(
      `include by ${refLabel(include)} requires an apiUrl (set it in deterministic.config.json or DETERMINISTIC_API_URL)`,
    );
  }
  const res = await fetchImpl(applicationPath(apiUrl, include));
  if (!res.ok) {
    throw new Error(
      `failed to fetch deterministic ${refLabel(include)}: HTTP ${res.status}`,
    );
  }
  return res.json();
}

/**
 * Build a `resolveIncludes`-style loader for a given saved-item type
 * (`datasource_types` / `view_types`). `file:` reads from disk relative to
 * `ctx.baseDir`; `id:` fetches the latest matching item text. `fileExtras(dir)`
 * / `idExtras(body)` contribute per-artifact extras (e.g. custom migrations) to
 * the returned record. Returns a `({ apiUrl, fetchImpl }) => load` factory.
 */
export function makeCombinedLoader({
  itemType,
  fileExtras,
  idExtras,
}: CombinedLoaderConfig) {
  async function loadFromFile(include: { file: string }, ctx: LoaderCtx) {
    const baseDir = ctx.baseDir ?? ".";
    const path = resolve(baseDir, include.file);
    const text = await readFile(path, "utf8");
    const extra = fileExtras ? await fileExtras(dirname(path)) : {};
    return {
      text,
      key: `file:${path}`,
      ctx: { baseDir: dirname(path) },
      ...extra,
    };
  }

  async function loadFromRef(
    include: Include,
    apiUrl: string | null,
    fetchImpl: FetchLike,
  ) {
    const body = await fetchApplicationBody(apiUrl, include, fetchImpl);
    const text = latestItemText(body, itemType);
    if (text == null) {
      throw new Error(
        `deterministic ${refLabel(include)} has no ${itemType} item`,
      );
    }
    const resolvedId = (body as { id?: number } | null)?.id ?? include.id;
    const extra = idExtras ? idExtras(body) : {};
    return { text, key: `id:${resolvedId}`, ctx: {}, ...extra };
  }

  return function combinedLoader({
    apiUrl = null,
    fetchImpl = fetch,
  }: { apiUrl?: string | null; fetchImpl?: FetchLike } = {}) {
    return async function load(include: Include, ctx: LoaderCtx) {
      if (include.file !== undefined) {
        return loadFromFile({ ...include, file: include.file }, ctx);
      }
      return loadFromRef(include, apiUrl, fetchImpl);
    };
  };
}
