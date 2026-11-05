import {
  connectDatabase,
  parseEnableMiddlewareEnv,
  type SupportedBackend,
} from "{{libImport}}";

async function resolveMigrationsDir(
  backend: string,
): Promise<string | undefined> {
  let cur = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(cur, "sql", backend, "migrations");
    if (await fileExists(candidate)) return candidate;
    cur = resolve(cur, "..");
  }
  return undefined;
}
