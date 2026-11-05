import { parseCustomMigrations } from "./custom-migrations-manifest.ts";
import { latestItemText, makeCombinedLoader } from "./include-loader-core.ts";

/**
 * A `resolveRoutesIncludes` loader for routes configs. `file:` reads another
 * routes.yaml relative to `ctx.baseDir` — a same-project include that shares the
 * one project datasource, so it carries no datasource of its own. An `id:` include
 * is a distinct saved deterministic: it carries that deterministic's OWN
 * `datasource_types` (`datasourceText`) + `custom_migrations` so the resolver
 * folds them in. `fetchImpl` defaults to `fetch`.
 */
export const combinedLoader = makeCombinedLoader({
  itemType: "routes",
  idExtras: (body) => {
    const manifest = latestItemText(body, "custom_migrations");
    return {
      datasourceText: latestItemText(body, "datasource_types"),
      customMigrations: manifest ? parseCustomMigrations(manifest) : {},
    };
  },
});
