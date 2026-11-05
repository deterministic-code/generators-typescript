import { parse, stringify } from "yaml";
import { SQL_DIALECTS, normalizeDialect } from "./generate-sql.ts";

/** One custom migration slot for a dialect: a 1-based `order`, a `name`, and the paired `up`/`down` SQL. This is the single wire shape shared by the CLI save path (which reads the local custom/ folder) and the id:-include fetch path (which re-generates the migrations), kept separate from the on-disk file layout so the store never depends on filenames. */
export interface CustomMigrationPair {
  order: number;
  name: string;
  up: string;
  down: string;
}

function assertPair(
  dialect: string,
  index: number,
  pair: CustomMigrationPair | null,
): asserts pair is CustomMigrationPair {
  const where = `custom_migrations[${dialect}][${index}]`;
  if (pair === null || typeof pair !== "object") {
    throw new Error(`${where} must be an object`);
  }
  if (!Number.isInteger(pair.order) || pair.order < 1 || pair.order > 999) {
    throw new Error(`${where}.order must be an integer in [1, 999]`);
  }
  for (const field of ["name", "up", "down"] as const) {
    if (typeof pair[field] !== "string" || pair[field].length === 0) {
      throw new Error(`${where}.${field} must be a non-empty string`);
    }
  }
}

// Serializes a { [dialect]: [{ order, name, up, down }] } map to the manifest YAML. Dialects are generated in canonical SQL_DIALECTS order and each list sorted by (order, name) so the stored text is stable across saves.
export function serializeCustomMigrations(
  byDialect: Record<string, CustomMigrationPair[]>,
): string {
  const out: Record<string, CustomMigrationPair[]> = {};
  for (const dialect of SQL_DIALECTS) {
    const key = normalizeDialect(dialect)!;
    const pairs = byDialect[key];
    if (!Array.isArray(pairs) || pairs.length === 0) continue;
    out[key] = [...pairs]
      .sort((a, b) =>
        a.order !== b.order
          ? a.order - b.order
          : a.name < b.name
            ? -1
            : a.name > b.name
              ? 1
              : 0,
      )
      .map((pair, index) => {
        assertPair(key, index, pair);
        return {
          order: pair.order,
          name: pair.name,
          up: pair.up,
          down: pair.down,
        };
      });
  }
  return stringify(out);
}

// Parses a `custom_migrations` item's manifest text back into a validated { [dialect]: [{ order, name, up, down }] } map. Unknown dialect keys and malformed pairs throw rather than silently dropping — a bad manifest is a real error, not an empty result.
export function parseCustomMigrations(
  text: string,
): Record<string, CustomMigrationPair[]> {
  const doc: Record<string, CustomMigrationPair[]> = parse(text) ?? {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("custom_migrations manifest must be a dialect-keyed map");
  }
  const out: Record<string, CustomMigrationPair[]> = {};
  for (const [rawDialect, pairs] of Object.entries(doc)) {
    const key = normalizeDialect(rawDialect);
    if (!key) {
      throw new Error(
        `custom_migrations manifest has unknown dialect '${rawDialect}'. Valid: ${SQL_DIALECTS.join(", ")}.`,
      );
    }
    if (!Array.isArray(pairs)) {
      throw new Error(`custom_migrations[${key}] must be a list`);
    }
    pairs.forEach((pair, index) => assertPair(key, index, pair));
    out[key] = pairs.map((pair) => ({
      order: pair.order,
      name: pair.name,
      up: pair.up,
      down: pair.down,
    }));
  }
  return out;
}
