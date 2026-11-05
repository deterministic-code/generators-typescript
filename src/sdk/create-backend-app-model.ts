// why per-language dev ports: 4000 is the deterministic dev server; distinct defaults let bare-metal TS/Rust/C# apps run simultaneously without collisions.
export const DEV_PORTS = Object.freeze({
  typescript: 4001,
  rust: 4002,
  csharp: 4003,
});

interface DatabaseConfig {
  backend: string;
  envBackend: string;
  envFile: string;
  envSchema: string;
  defaultBackend: string;
  defaultFile: string;
  defaultSchema: string;
}

interface AppModel {
  appName: string;
  database: DatabaseConfig;
  byFeature: boolean;
}

export function buildAppModel({
  backendAppConfig,
  applicationName,
  byFeature = false,
}: {
  backendAppConfig?: { name?: string } | null;
  applicationName?: string;
  byFeature?: boolean;
}): AppModel {
  const database: DatabaseConfig = {
    backend: "sqlite",
    envBackend: "DATABASE_BACKEND",
    envFile: "DB_PATH",
    envSchema: "DB_SCHEMA_PATH",
    defaultBackend: "sqlite",
    defaultFile: ":memory:",
    defaultSchema: "./sql/sqlite.sql",
  };

  const appName = applicationName || backendAppConfig?.name || "generated-app";

  return {
    appName,
    database,
    byFeature,
  };
}

// C#/.NET project name (PascalCase) derived from the app model — lives here, not in the csharp generator, so shared compose helpers don't depend on a language module.
export function deriveCSharpProjectName(
  model: { projectName?: string; appName?: string } | null | undefined,
): string {
  const raw =
    (model && typeof model.projectName === "string" && model.projectName) ||
    (model && typeof model.appName === "string" && model.appName) ||
    "App";
  const parts = raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (parts.length === 0) return "App";
  const pascal = parts
    .map((p: string) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join("");
  return /^[A-Za-z]/.test(pascal) ? pascal : `App${pascal}`;
}
