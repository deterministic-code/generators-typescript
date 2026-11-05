import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { dump as yamlDump } from "js-yaml";
import { hashBody } from "./content-hash.ts";
import { pathExists } from "./path-exists.ts";
import { MANIFEST_FILENAME } from "./manifest-filename.ts";

export { MANIFEST_FILENAME };

const SWEEP_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  ".scratch",
  ".worktrees",
  ".next",
  ".turbo",
]);

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function relPosix(rootDir: string, filePath: string): string {
  const rel = relative(rootDir, filePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `hash-manifest: file ${filePath} is outside manifest root ${rootDir}`,
    );
  }
  return toPosix(rel);
}

function serializeManifest(entries: Record<string, string>): string {
  if (Object.keys(entries).length === 0) return "";
  return yamlDump(entries, {
    sortKeys: true,
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
  });
}

async function saveManifest(
  manifestPath: string,
  entries: Record<string, string>,
): Promise<string | null> {
  const payload = serializeManifest(entries);
  await rm(manifestPath, { force: true });
  if (payload.length === 0) return null;
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, payload, "utf8");
  return payload;
}

async function hashFileOnDisk(filePath: string): Promise<string | null> {
  if (!(await pathExists(filePath))) return null;
  const body = await readFile(filePath, "utf8");
  return hashBody(body);
}

// The sole producer of <projectRoot>/deterministic/deterministic-hashes.yaml: hashes the final tree once, after every writer (generate assemble, Dockerfile/Cargo patchers) has run, and returns the written {relPath, content} (or null when empty) so the run can record it without re-reading disk. Keys stay project-root-relative; the manifest lives under the deterministic/ contract folder but excludes itself via the collectHashes name-skip.
export async function rebuildRootManifest(
  projectRoot: string,
): Promise<{ relPath: string; content: string } | null> {
  const root = resolve(projectRoot);
  const entries: Record<string, string> = {};
  await collectHashes(root, root, entries);
  const manifestPath = join(root, "deterministic", MANIFEST_FILENAME);
  const content = await saveManifest(manifestPath, entries);
  if (content === null) return null;
  return { relPath: toPosix(relative(root, manifestPath)), content };
}

async function collectHashes(
  dir: string,
  root: string,
  entries: Record<string, string>,
): Promise<void> {
  let dirEntries: Dirent[];
  try {
    dirEntries = await readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw err;
  }
  for (const entry of dirEntries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SWEEP_SKIP_DIRS.has(entry.name)) continue;
      await collectHashes(full, root, entries);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === MANIFEST_FILENAME) continue;
    const hash = await hashFileOnDisk(full);
    if (hash) entries[relPosix(root, full)] = hash;
  }
}
