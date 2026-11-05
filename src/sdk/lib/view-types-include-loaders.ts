import { parseCustomMigrations } from "./custom-migrations-manifest.ts";
import { latestItemText, makeCombinedLoader } from "./include-loader-core.ts";

/**
 * A `resolveViewIncludes` loader for view_types configs. `file:` reads another
 * view_types.yaml relative to `ctx.baseDir` — a same-project include that shares
 * the one project datasource, so it carries no datasource of its own. An `id:`
 * include is a distinct saved deterministic: it carries that deterministic's OWN
 * `datasource_types` (`datasourceText`) + `custom_migrations` so the resolver
 * folds them into the datasource its views `inherits:`/reference. `fetchImpl`
 * defaults to `fetch`.
 */
export const combinedLoader = makeCombinedLoader({
  itemType: "view_types",
  idExtras: (body) => {
    const manifest = latestItemText(body, "custom_migrations");
    return {
      datasourceText: latestItemText(body, "datasource_types"),
      customMigrations: manifest ? parseCustomMigrations(manifest) : {},
    };
  },
});
