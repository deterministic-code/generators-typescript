import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CONFIG_NAME = "deterministic.config.json";
const LOCAL_API_URL = "http://localhost:4000";
const PROD_API_URL = "https://deterministic-code.com";
const LOCAL_SHORTCUTS = new Set(["local", "localhost", "dev"]);
const PROD_SHORTCUTS = new Set(["prod", "production"]);

interface DeterministicConfig {
  apiUrl?: unknown;
  backendIdOrName?: unknown;
}

function expandApiUrlShortcut(value: string): string {
  const v = value.trim().toLowerCase();
  if (LOCAL_SHORTCUTS.has(v)) return LOCAL_API_URL;
  if (PROD_SHORTCUTS.has(v)) return PROD_API_URL;
  return value;
}

/** Reads and parses `deterministic.config.json` from `cwd`, or returns null when the file is absent. A present-but-malformed file throws (JSON.parse) rather than being swallowed — a broken config is a real error. */
async function readConfigObject(
  cwd: string,
): Promise<DeterministicConfig | null> {
  const path = resolve(cwd, CONFIG_NAME);
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return null;
  return JSON.parse(raw);
}

/**
 * The `apiUrl` from a project's `deterministic.config.json` (searched at `cwd`),
 * with `local`/`prod` shortcuts expanded and any trailing slash stripped. Returns
 * `null` when the file is absent, unreadable-as-JSON, or has no `apiUrl` — callers
 * layer it under their flag/env precedence, so a missing config is not an error.
 */
export async function readConfigApiUrl(
  cwd: string = process.cwd(),
): Promise<string | null> {
  const apiUrl = (await readConfigObject(cwd))?.apiUrl;
  if (typeof apiUrl !== "string" || apiUrl.length === 0) return null;
  return expandApiUrlShortcut(apiUrl).replace(/\/$/, "");
}

/**
 * The numeric backend deterministic id from `deterministic.config.json`'s
 * `backendIdOrName`, or `null` when the config is absent or the value is a
 * non-numeric name (callers that need an id then require an explicit flag, since
 * name→id resolution is a separate lookup).
 */
export async function readConfigBackendId(
  cwd: string = process.cwd(),
): Promise<number | null> {
  const value = (await readConfigObject(cwd))?.backendIdOrName;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}
