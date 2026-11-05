import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTENT, PATCH, type GenerateEntry } from "./generate-result.ts";

const CREATE_BACKEND_APP_TEMPLATE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates",
  "create-backend-app",
);

function readVitestConfig(configName: string): Promise<string> {
  return readFile(
    join(CREATE_BACKEND_APP_TEMPLATE_DIR, `${configName}.tmpl`),
    "utf8",
  );
}

/** Perf-server TS harness as generate entries: the vitest config file + a package.json `test:perf` script merge, routed through GeneratePlan's content/patch writers. */
export async function perfServerTypescriptEntries(): Promise<GenerateEntry[]> {
  return [
    {
      kind: CONTENT,
      filename: "vitest.perf.config.ts",
      contents: await readVitestConfig("vitest.perf.config.ts"),
    },
    {
      kind: PATCH,
      filename: "package.json",
      content: JSON.stringify({
        scripts: { "test:perf": "vitest run --config vitest.perf.config.ts" },
      }),
    },
  ];
}

/** Perf-server rust harness: the Cargo.toml `[[bin]]` marked-block patch (backend_app pre-seeds the PERF_BIN markers). */
export function perfServerRustEntries(): GenerateEntry[] {
  return [
    {
      kind: PATCH,
      filename: "Cargo.toml",
      content: '[[bin]]\nname = "perf_server"\npath = "src/bin/perf_server.rs"',
      section: "PERF_BIN",
    },
  ];
}
