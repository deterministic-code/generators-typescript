import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/** Return the first `candidates` path that is an existing directory, or throw `notFoundMessage` (with the tried paths appended) when none match — the shared "which vendored library dir is present" probe for the bundled TS-dist / rust-crate resolvers. */
export async function firstExistingDir(
  candidates: string[],
  notFoundMessage: string,
): Promise<string> {
  for (const candidate of candidates) {
    const s = await stat(candidate).catch((err: NodeJS.ErrnoException) => {
      if (err && err.code === "ENOENT") return null;
      throw err;
    });
    if (s?.isDirectory()) return candidate;
  }
  throw new Error(`${notFoundMessage} Tried:\n  ${candidates.join("\n  ")}`);
}
