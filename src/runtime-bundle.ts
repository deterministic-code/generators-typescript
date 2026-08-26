import { spawn } from "node:child_process";
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

const packRoot = (): string => join(packDir(), "..");

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

const bundleCandidates = (): string[] => {
  const here = packDir();
  const root = packRoot();
  return [
    join(root, "runtime", "dist"),
    join(root, "dist", "runtime-bundle"),
    join(here, "runtime-bundle"),
  ];
};

const findRuntimeBundleDir = async (): Promise<string | undefined> => {
  for (const dir of bundleCandidates()) {
    if (await readable(join(dir, "app.js"))) return dir;
  }
  return undefined;
};

const runNpm = (args: string[], cwd: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn("npm", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `npm ${args.join(" ")} exited ${String(code)} in ${cwd}\n${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    });
  });

const ensureRuntimeBuilt = async (): Promise<void> => {
  const runtimeRoot = join(packRoot(), "runtime");
  if (!(await readable(join(runtimeRoot, "package.json")))) {
    throw new Error(
      "bundled library_reference_mode needs the TypeScript runtime sources at runtime/ — they were not shipped with this pack",
    );
  }
  if (!(await readable(join(runtimeRoot, "node_modules")))) {
    await runNpm(["install", "--no-audit", "--no-fund"], runtimeRoot);
  }
  await runNpm(["run", "build"], runtimeRoot);
};

/** Directory of the built runtime (`app.js`, `routes.js`, hashed ESM chunks). */
export const resolveRuntimeBundleDir = async (): Promise<string> => {
  const existing = await findRuntimeBundleDir();
  if (existing !== undefined) return existing;
  await ensureRuntimeBuilt();
  const built = await findRuntimeBundleDir();
  if (built !== undefined) return built;
  throw new Error(
    "bundled library_reference_mode could not produce runtime/dist — run `npm run build` in runtime/",
  );
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

const runtimePackagePath = async (): Promise<string | undefined> => {
  const root = packRoot();
  const here = packDir();
  for (const path of [
    join(root, "runtime", "package.json"),
    join(here, "runtime-package.json"),
  ]) {
    if (await readable(path)) return path;
  }
  return undefined;
};

export const runtimePackageVersion = async (): Promise<string> => {
  const path = await runtimePackagePath();
  if (path === undefined) return FALLBACK_RUNTIME_VERSION;
  const pkg = JSON.parse(await readFile(path, "utf8")) as { version?: string };
  if (pkg.version !== undefined && pkg.version !== "") return pkg.version;
  return FALLBACK_RUNTIME_VERSION;
};

const bundledRuntimeDeps = async (): Promise<Record<string, string>> => {
  const path = await runtimePackagePath();
  if (path === undefined) return {};
  const pkg = JSON.parse(await readFile(path, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return { ...pkg.dependencies };
};

export const applyBundledPackageJson = async (raw: string): Promise<string> => {
  const pkg = JSON.parse(raw) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    allowScripts?: Record<string, boolean>;
    overrides?: Record<string, string>;
  };
  const dependencies = { ...pkg.dependencies, ...(await bundledRuntimeDeps()) };
  delete dependencies["@deterministic-code/deterministic"];
  const allowScripts = { ...pkg.allowScripts };
  delete allowScripts["@deterministic-code/deterministic"];
  const overrides = { ...pkg.overrides };
  delete overrides["better-sqlite3"];
  return `${JSON.stringify(
    {
      ...pkg,
      scripts: {
        ...pkg.scripts,
        build: "tsc && cp -R _deterministic dist/_deterministic",
      },
      dependencies,
      allowScripts,
      overrides,
    },
    null,
    2,
  )}\n`;
};
