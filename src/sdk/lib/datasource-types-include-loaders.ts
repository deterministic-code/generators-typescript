import { readCustomMigrationsByDialect } from "./custom-migrations-source.ts";
import { parseCustomMigrations } from "./custom-migrations-manifest.ts";
import { latestItemText, makeCombinedLoader } from "./include-loader-core.ts";

/**
 * A `resolveIncludes` loader for datasource_types configs. `file:` reads from
 * disk relative to `ctx.baseDir` and carries that folder's `custom/<dialect>/`
 * migrations forward as `customMigrations`; `id:` fetches the latest
 * `datasource_types` item and parses any latest `custom_migrations` item into
 * `customMigrations`. `fetchImpl` defaults to the global `fetch`.
 */
export const combinedLoader = makeCombinedLoader({
  itemType: "datasource_types",
  fileExtras: async (dir) => ({
    customMigrations: await readCustomMigrationsByDialect(dir),
  }),
  idExtras: (body) => {
    const manifest = latestItemText(body, "custom_migrations");
    return {
      customMigrations: manifest ? parseCustomMigrations(manifest) : {},
    };
  },
});
