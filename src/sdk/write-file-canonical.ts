import { readFile, rm, writeFile } from "node:fs/promises";
import { pathExists } from "./path-exists.ts";

function normalizeOptions(
  arg: BufferEncoding | { encoding?: BufferEncoding } | undefined,
): { encoding?: BufferEncoding } {
  if (typeof arg === "string") return { encoding: arg };
  return arg ?? {};
}

// Writes only when the on-disk content differs, so re-generating a byte-identical file is a no-op. The file-hash manifest (deterministic/deterministic-hashes.yaml) is built once at the end of a run from the final tree — it is no longer a per-write side effect here (that scattered stub manifests into every subdir before the project root was pinned).
export async function writeFileCanonical(
  filePath: string,
  content: string,
  optionsOrEncoding?: BufferEncoding | { encoding?: BufferEncoding },
): Promise<void> {
  const { encoding = "utf8" } = normalizeOptions(optionsOrEncoding);
  const existing = (await pathExists(filePath))
    ? await readFile(filePath, encoding)
    : null;
  if (existing === content) return;
  await rm(filePath, { force: true });
  await writeFile(filePath, content, encoding);
}
