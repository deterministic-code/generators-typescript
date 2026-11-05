import { join } from "node:path";
import { backendLaneDir } from "../../backend-lane.ts";

// backendLaneDir is the pure layout primitive shared with the SDK dockerignore writer (which derives the root .dockerignore's lane prefixes from settings); it lives in the SDK so both derive lane dirs from one source.
export { backendLaneDir };

/** The output root a backend per-language step writes into, i.e. `root` joined with `backendLaneDir(opts)`. Flat (`""` lane) returns `root` unchanged so single-tier single-language output is byte-identical. */
export function backendLaneRoot(
  root: string,
  opts: Parameters<typeof backendLaneDir>[0],
): string {
  const dir = backendLaneDir(opts);
  return dir === "" ? root : join(root, dir.slice(0, -1));
}

/** The output root a backend-shared tree (sql/, openapi/) writes into: nested under `backend/` in combined generation so it ships inside the self-contained backend project (and its migrate scripts resolve `sql/…` beside package.json), else the run root. Unlike backendLaneRoot it never adds the `<lang>/` segment — these trees are shared across the backend's languages. */
export function backendSharedRoot(
  root: string,
  { combined = false }: { combined?: boolean } = {},
): string {
  return combined ? join(root, "backend") : root;
}

/** Shared-scope steps whose single output tree is part of the deployable backend and nests under `backend/` in combined mode — as opposed to the `deterministic/`-writing shared steps (setup, performance_plan, validate) that stay at the run root beside docker-compose.yml. `sql/` (`sql/<dialect>/migrations`, including the `stored_procedures` step's `0002` migration) and `openapi/` are generate-once shared trees: one copy serves every backend lane, co-located into each lane's Dockerfile/verify build context, so there is never a per-lane `<lang>/sql`. */
export const BACKEND_SHARED_STEPS = new Set([
  "sql",
  "stored_procedures",
  "openapi_docs",
]);

/** Run-mode flag the runners pass to the combined-aware backend generators so the deployment paths they encode in their generated content carry the `backend/` lane prefix. Combined nesting of every step's *output dir* is computed by the runner (`stepOutputFor`/`outputFor`); only the steps in COMBINED_AWARE_STEPS also bake lane-relative paths into content (backend_app: Dockerfile/compose; migrate_scripts: the Dockerfile MIGRATE_COPY), so only they receive the flag. */
export const COMBINED_FLAG = {
  flag: "--combined",
  target: "combined",
  kind: "boolean",
  defaultValue: false,
  description:
    "Combined (tier=all) run: nest the backend app under backend/ alongside the frontend's frontend/.",
};

/** The per-language steps that bake combined-mode content and therefore need `--combined`: backend_app + migrate_scripts carry the `backend/` lane prefix in their Dockerfile/compose; frontend_app generates its docker-compose service only in combined mode. Every other step's placement is handled by the runner's output-dir prefix alone. */
export const COMBINED_AWARE_STEPS = new Set([
  "backend_app",
  "migrate_scripts",
  "frontend_app",
]);
