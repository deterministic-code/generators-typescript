import { posix } from "node:path";

const NPM_PACKAGE = "@deterministic-code/deterministic";

/** Join a base dir and file into an import specifier, normalizing a trailing slash and the `.` base to `./`. */
export function joinImport(base: string, file: string): string {
  if (base === ".") return `./${file}`;
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return `${normalized}${file}`;
}

/** Resolve the import specifier for the deterministic library at `subpath` (e.g. "services" | "routes" | "app"; "" is the package root). `mode` undefined is treated as "npm"; only "bundled" redirects to the vendored `_deterministic/…js` relative to `generatedFileRelToProjectRoot`. */
export function libraryImportSpecifier(
  subpath: string,
  mode: string | undefined,
  generatedFileRelToProjectRoot: string,
): string {
  if (mode !== "bundled") {
    return subpath ? `${NPM_PACKAGE}/${subpath}` : NPM_PACKAGE;
  }
  const dir = posix.dirname(generatedFileRelToProjectRoot);
  let rel = posix.relative(dir, "_deterministic");
  if (!rel) rel = ".";
  if (!rel.startsWith(".")) rel = `./${rel}`;
  // why explicit .js for bundled: tsc with moduleResolution=bundler preserves the import string verbatim into the compiled JS; Node ESM at runtime requires an explicit extension or a package.json exports map — bundled `_deterministic/` ships neither, so the extension goes on at generate-time. Missing it triggered ERR_MODULE_NOT_FOUND on `/app/dist/_deterministic/app` even after PR #1122's runtime-stage COPY landed.
  return subpath ? `${rel}/${subpath}.js` : `${rel}/index.js`;
}
