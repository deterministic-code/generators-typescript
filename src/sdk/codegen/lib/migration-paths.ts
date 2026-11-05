import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const CUSTOM_TOKEN = "_custom_";

export const LEGACY_INITIAL_MIGRATION_RE = /^\d{10,}_initial_(up|down)\.sql$/;

export function isLegacyInitialMigrationFilename(filename: string): boolean {
  return LEGACY_INITIAL_MIGRATION_RE.test(filename);
}

export async function findLegacyInitialMigrations(
  migrationsDir: string,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(migrationsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  return entries.filter(isLegacyInitialMigrationFilename).sort();
}

export async function assertNoLegacyInitialMigration(
  migrationsDir: string,
): Promise<void> {
  const legacy = await findLegacyInitialMigrations(migrationsDir);
  if (legacy.length === 0) return;
  const legacyPaths = legacy.map((name) => join(migrationsDir, name));
  throw new Error(
    `Refusing to generate 0001_initial_up.sql / 0001_initial_down.sql into ${migrationsDir}: ` +
      `a legacy timestamped initial migration already exists (${legacyPaths.join(", ")}). ` +
      `Writing both forms would create a duplicate-initial migration chain. ` +
      `Either (a) delete the legacy file(s) above after verifying your dev DB does not depend on them, ` +
      `or (b) collapse the migration chain manually so only one initial migration remains.`,
  );
}
