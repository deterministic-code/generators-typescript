import { CUSTOM_TOKEN } from "./migration-paths.ts";
import { readCustomMigrationPairs } from "../../lib/custom-migrations-source.ts";

export {
  customMigrationsDirFor,
  discoverCustomMigrations,
} from "../../lib/custom-migrations-source.ts";

type Direction = "up" | "down";

export interface CustomMigrationPair {
  order: number;
  name: string;
  up: string;
  down: string;
  upSourcePath?: string;
  downSourcePath?: string;
}

interface CustomMigrationFile {
  filename: string;
  content: string;
  source?: string;
}

// why epoch-anchored: any prefix starting with '0' lexicographically sorts before '0001_initial_up.sql' AND before any 10-digit unix-timestamp baseline ('1...'). Mapping order N → 10-digit zero-padded "0000000NNN" keeps custom migrations strictly ahead.
export function generatedFilenameForCustom(
  order: number,
  name: string,
  direction: Direction,
): string {
  if (!Number.isInteger(order) || order < 1 || order > 999) {
    throw new Error(
      `generatedFilenameForCustom: order must be an integer in [1, 999], got ${order}`,
    );
  }
  if (direction !== "up" && direction !== "down") {
    throw new Error(
      `generatedFilenameForCustom: direction must be "up" or "down", got "${direction}"`,
    );
  }
  const stamp = String(order).padStart(10, "0");
  return `${stamp}${CUSTOM_TOKEN}${String(order).padStart(3, "0")}_${name}_${direction}.sql`;
}

// Returns [{ filename, content, source }] for every local custom file to write into the dialect's migrations dir. Pure read; does NOT mutate the source folder.
export async function buildCustomMigrationFiles(
  deterministicDir: string,
  dialect: string,
): Promise<CustomMigrationFile[]> {
  const pairs = await readCustomMigrationPairs(deterministicDir, dialect);
  return pairs.flatMap((pair) => [
    {
      filename: generatedFilenameForCustom(pair.order, pair.name, "up"),
      content: pair.up,
      source: pair.upSourcePath,
    },
    {
      filename: generatedFilenameForCustom(pair.order, pair.name, "down"),
      content: pair.down,
      source: pair.downSourcePath,
    },
  ]);
}

// Maps an already-loaded { order, name, up, down } pair list (e.g. an included datasource's carried custom migrations) to generated up+down entries for a dialect, reusing the same filename scheme as local custom migrations. Included and local pairs share the [1,999] order space; an exact (order, name) collision across sources is a hard error raised where they are merged.
export function generateFilesFromPairs(
  pairs: CustomMigrationPair[],
): CustomMigrationFile[] {
  return pairs.flatMap((pair) => [
    {
      filename: generatedFilenameForCustom(pair.order, pair.name, "up"),
      content: pair.up,
    },
    {
      filename: generatedFilenameForCustom(pair.order, pair.name, "down"),
      content: pair.down,
    },
  ]);
}
