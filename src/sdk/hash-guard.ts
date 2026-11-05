import { load as yamlLoad } from "js-yaml";
import { MANIFEST_FILENAME } from "./manifest-filename.ts";

export { MANIFEST_FILENAME };

interface ManifestDiff {
  changed: string[];
  missing: string[];
}

export function parseManifest(yamlText: string): Record<string, string> {
  if (!yamlText || yamlText.trim().length === 0) return {};
  const parsed = yamlLoad(yamlText);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("hash-guard: manifest is not a map of path -> sha256");
  }
  const entries: Record<string, string> = {};
  for (const [path, hash] of Object.entries(parsed)) {
    if (typeof hash !== "string") {
      throw new Error(
        `hash-guard: manifest entry ${path} is not a string hash`,
      );
    }
    entries[path] = hash;
  }
  return entries;
}

// changed = recorded file whose current hash differs; missing = recorded file now absent (hand-deleted); either means the prior generated tree was edited.
export function diffManifest(
  recorded: Record<string, string>,
  current: Record<string, string>,
): ManifestDiff {
  const changed: string[] = [];
  const missing: string[] = [];
  for (const [path, recordedHash] of Object.entries(recorded)) {
    const currentHash = current[path];
    if (currentHash === undefined) {
      missing.push(path);
    } else if (currentHash !== recordedHash) {
      changed.push(path);
    }
  }
  changed.sort();
  missing.sort();
  return { changed, missing };
}

export function hasManifestDrift(diff: ManifestDiff): boolean {
  return diff.changed.length > 0 || diff.missing.length > 0;
}
