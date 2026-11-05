import { createRequire } from "node:module";
import { resolve, sep } from "node:path";

const requireFromHere = createRequire(import.meta.url);

const specificationsPackage =
  "@deterministic-code/deterministic-specifications";

/**
 * Absolute path to a file published by
 * `@deterministic-code/deterministic-specifications`, addressed by its
 * package-relative subpath — e.g. `backend/types.yaml` or
 * `backend/datasource-types.spec.yaml`. Resolved via the package's
 * `package.json` since the package ships no JS entrypoint.
 */
export function packagedSpecPath(subPath: string): string {
  const entry = requireFromHere.resolve(
    `${specificationsPackage}/package.json`,
  );
  const scoped = specificationsPackage.split("/").join(sep);
  const marker = `node_modules${sep}${scoped}`;
  const end = entry.lastIndexOf(marker);
  if (end === -1) {
    throw new Error(`invariant: ${specificationsPackage} unresolved`);
  }
  return resolve(entry.slice(0, end + marker.length), subPath);
}
