import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SQL_DIALECTS, normalizeDialect } from "./generate-sql.ts";
import type { CustomMigrationPair } from "./custom-migrations-manifest.ts";

const ORDER_FILENAME_RE = /^(\d+)_([A-Za-z0-9][A-Za-z0-9_-]*)_(up|down)\.sql$/;

interface DiscoveredMigration {
  order: number;
  name: string;
  upSourceFilename: string;
  downSourceFilename: string;
  upSourcePath: string;
  downSourcePath: string;
}

interface ReadCustomMigrationPair extends CustomMigrationPair {
  upSourcePath: string;
  downSourcePath: string;
}

interface DirectionBuckets {
  ups: Map<string, string>;
  downs: Map<string, string>;
}

export function customMigrationsDirFor(
  deterministicDir: string,
  dialect: string,
): string {
  const key = normalizeDialect(dialect);
  if (!key) {
    throw new Error(
      `customMigrationsDirFor: unknown SQL dialect "${dialect}". Valid: ${SQL_DIALECTS.join(", ")}.`,
    );
  }
  return join(deterministicDir, "custom", key);
}

async function readSqlDirEntries(dir: string): Promise<string[] | null> {
  let st;
  try {
    st = await stat(dir);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (!st.isDirectory()) {
    throw new Error(
      `discoverCustomMigrations: ${dir} exists but is not a directory`,
    );
  }
  return (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
}

// Sorts filenames into up/down maps keyed by `order|name`, validating the naming pattern, the [1,999] order bound, and same-direction duplicates.
function bucketByDirection(dir: string, entries: string[]): DirectionBuckets {
  const ups = new Map<string, string>();
  const downs = new Map<string, string>();
  for (const filename of entries) {
    const m = filename.match(ORDER_FILENAME_RE);
    if (!m) {
      throw new Error(
        `discoverCustomMigrations: ${join(dir, filename)} does not match expected pattern <order>_<name>_(up|down).sql`,
      );
    }
    const order = Number.parseInt(m[1], 10);
    if (order < 1 || order > 999) {
      throw new Error(
        `discoverCustomMigrations: ${join(dir, filename)} has order ${order}; must be in [1, 999]`,
      );
    }
    const key = `${order}|${m[2]}`;
    const bucket = m[3] === "up" ? ups : downs;
    if (bucket.has(key)) {
      throw new Error(
        `discoverCustomMigrations: duplicate ${m[3]} file for order=${order} name=${m[2]} in ${dir}`,
      );
    }
    bucket.set(key, filename);
  }
  return { ups, downs };
}

function assertUpDownComplete(
  dir: string,
  ups: Map<string, string>,
  downs: Map<string, string>,
): void {
  const missing: string[] = [];
  for (const key of new Set([...ups.keys(), ...downs.keys()])) {
    if (!ups.has(key))
      missing.push(
        `missing _up.sql counterpart for ${downs.get(key)} in ${dir}`,
      );
    if (!downs.has(key))
      missing.push(
        `missing _down.sql counterpart for ${ups.get(key)} in ${dir}`,
      );
  }
  if (missing.length > 0) {
    throw new Error(
      `discoverCustomMigrations: ${missing.length} mismatched up/down pair(s):\n  ${missing.join("\n  ")}`,
    );
  }
}

function orderNameKeyCompare(a: string, b: string): number {
  const [oa, na] = a.split("|");
  const [ob, nb] = b.split("|");
  const da = Number.parseInt(oa, 10) - Number.parseInt(ob, 10);
  return da !== 0 ? da : na < nb ? -1 : 1;
}

// Lists the discovered custom migration pairs for a dialect, sorted by (order, name) ascending. Returns [] when the folder does not exist (missing-is-empty is the documented "no custom migrations" signal). Each pair carries its source paths; content is read by readCustomMigrationPairs.
export async function discoverCustomMigrations(
  deterministicDir: string,
  dialect: string,
): Promise<DiscoveredMigration[]> {
  const dir = customMigrationsDirFor(deterministicDir, dialect);
  const entries = await readSqlDirEntries(dir);
  if (entries === null) return [];
  const { ups, downs } = bucketByDirection(dir, entries);
  assertUpDownComplete(dir, ups, downs);
  const keys = [...new Set([...ups.keys(), ...downs.keys()])].sort(
    orderNameKeyCompare,
  );
  return keys.map((key) => {
    const [orderStr, name] = key.split("|");
    const upSourceFilename = ups.get(key)!;
    const downSourceFilename = downs.get(key)!;
    return {
      order: Number.parseInt(orderStr, 10),
      name,
      upSourceFilename,
      downSourceFilename,
      upSourcePath: join(dir, upSourceFilename),
      downSourcePath: join(dir, downSourceFilename),
    };
  });
}

// Reads each discovered pair's up/down SQL text. The dialect-keyed shape { order, name, up, down } is the shared currency between the migrate generator (local `custom/` folder) and the includes loader (an included datasource's `custom/` folder or its fetched manifest).
export async function readCustomMigrationPairs(
  deterministicDir: string,
  dialect: string,
): Promise<ReadCustomMigrationPair[]> {
  const pairs = await discoverCustomMigrations(deterministicDir, dialect);
  return Promise.all(
    pairs.map(async (pair) => ({
      order: pair.order,
      name: pair.name,
      up: await readFile(pair.upSourcePath, "utf8"),
      down: await readFile(pair.downSourcePath, "utf8"),
      upSourcePath: pair.upSourcePath,
      downSourcePath: pair.downSourcePath,
    })),
  );
}

// Writes a { [dialect]: [{ order, name, up, down }] } map (e.g. resolved from an id: include) into a `deterministic/` folder's `custom/<dialect>/<order>_<name>_(up|down).sql` layout, so the migrate generator's discovery picks them up exactly like local custom migrations. Uses an exclusive write: a target that already exists (a local custom migration, or a second include, claiming the same slot) is a genuine collision and throws rather than clobbering.
export async function writeCustomMigrationsToDir(
  deterministicDir: string,
  byDialect: Record<string, CustomMigrationPair[]>,
): Promise<void> {
  for (const [dialect, pairs] of Object.entries(byDialect ?? {})) {
    const dir = customMigrationsDirFor(deterministicDir, dialect);
    await mkdir(dir, { recursive: true });
    for (const pair of pairs) {
      await writeExclusive(dir, `${pair.order}_${pair.name}_up.sql`, pair.up);
      await writeExclusive(
        dir,
        `${pair.order}_${pair.name}_down.sql`,
        pair.down,
      );
    }
  }
}

async function writeExclusive(
  dir: string,
  filename: string,
  content: string,
): Promise<void> {
  const path = join(dir, filename);
  await writeFile(path, content, { flag: "wx" }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === "EEXIST") {
        throw new Error(
          `custom migration collision: ${path} already exists — an included datasource and this project define the same (order, name)`,
        );
      }
      throw err;
    },
  );
}

// Reads every dialect's custom migration pairs from one `deterministic/` folder into a { [dialect]: [{ order, name, up, down }] } map, omitting dialects with none. Used by the includes file: loader to carry an included datasource's custom SQL forward.
export async function readCustomMigrationsByDialect(
  deterministicDir: string,
): Promise<Record<string, CustomMigrationPair[]>> {
  const out: Record<string, CustomMigrationPair[]> = {};
  for (const dialect of SQL_DIALECTS) {
    const pairs = await readCustomMigrationPairs(deterministicDir, dialect);
    if (pairs.length > 0) {
      out[normalizeDialect(dialect)!] = pairs.map(
        ({ order, name, up, down }) => ({
          order,
          name,
          up,
          down,
        }),
      );
    }
  }
  return out;
}
