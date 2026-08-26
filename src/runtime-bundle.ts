import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";

const BUNDLE_PREFIX = "_deterministic";
const FALLBACK_RUNTIME_VERSION = "0.0.7";

const readable = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const packDir = (): string => dirname(fileURLToPath(import.meta.url));

const shouldEmit = (name: string): boolean => {
  if (name.endsWith(".cjs") || name.endsWith(".cjs.map")) return false;
  return (
    name.endsWith(".js") ||
    name.endsWith(".js.map") ||
    name.endsWith(".d.ts")
  );
};

const listRelFiles = async (root: string): Promise<string[]> => {
  const walk = async (dir: string, rel: string): Promise<string[]> => {
    const ents = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const ent of ents) {
      const nextRel = rel === "" ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) {
        out.push(...(await walk(join(dir, ent.name), nextRel)));
      } else if (ent.isFile() && shouldEmit(ent.name)) {
        out.push(nextRel);
      }
    }
    return out;
  };
  return walk(root, "");
};

/** Directory of the built runtime (`app.js`, `routes.js`, hashed ESM chunks). */
export const resolveRuntimeBundleDir = async (): Promise<string> => {
  const here = packDir();
  const candidates = [
    join(here, "..", "runtime", "dist"),
    join(here, "runtime-bundle"),
  ];
  for (const dir of candidates) {
    if (await readable(join(dir, "app.js"))) return dir;
  }
  throw new Error(
    "bundled library_reference_mode requires a built runtime at runtime/dist — run `npm run build` in runtime/",
  );
};

export const runtimePackageVersion = async (): Promise<string> => {
  const here = packDir();
  const candidates = [
    join(here, "..", "runtime", "package.json"),
    join(here, "runtime-package.json"),
  ];
  for (const path of candidates) {
    if (!(await readable(path))) continue;
    const pkg = JSON.parse(await readFile(path, "utf8")) as { version?: string };
    if (pkg.version !== undefined && pkg.version !== "") return pkg.version;
  }
  return FALLBACK_RUNTIME_VERSION;
};

/** Emit the compiled runtime under `_deterministic/` for `library_reference_mode: bundled`. */
export const bundledRuntimeEntries = async (
  bundleDir: string,
): Promise<GenerateEntry[]> => {
  const rels = await listRelFiles(bundleDir);
  if (rels.length === 0) {
    throw new Error(
      `bundled runtime directory is empty: ${bundleDir}`,
    );
  }
  return Promise.all(
    rels.map(async (rel) =>
      content(
        `${BUNDLE_PREFIX}/${rel}`,
        await readFile(join(bundleDir, rel), "utf8"),
      ),
    ),
  );
};

/** Runtime packages the generated app must install when the library is vendored. */
export const BUNDLED_RUNTIME_DEPS: Record<string, string> = {
  "better-sqlite3": "^12.10.0",
  cors: "^2.8.5",
  express: "^4.21.0",
  helmet: "^8.0.0",
  "js-yaml": "^4.1.1",
  jsonwebtoken: "^9.0.2",
  pluralize: "^8.0.0",
  zod: "^3.23.8",
};

export const applyBundledPackageJson = (raw: string): string => {
  const pkg = JSON.parse(raw) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    allowScripts?: Record<string, boolean>;
  };
  const dependencies = { ...pkg.dependencies, ...BUNDLED_RUNTIME_DEPS };
  delete dependencies["@deterministic-code/deterministic"];
  const allowScripts = { ...pkg.allowScripts };
  delete allowScripts["@deterministic-code/deterministic"];
  return `${JSON.stringify(
    {
      ...pkg,
      scripts: {
        ...pkg.scripts,
        build: "tsc && cp -R _deterministic dist/_deterministic",
      },
      dependencies,
      allowScripts,
    },
    null,
    2,
  )}\n`;
};
