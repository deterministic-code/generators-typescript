import { join } from "node:path";
import {
  CONTENT,
  PATCH,
  type GenerateEntry,
} from "../../sdk/codegen/lib/generate-result.ts";

const VITEST_VERSION = "^2.1.0";
const ZOD_VERSION = "^3.23.8";
/** The bindings-live setup + axios live tests read process.env.BINDINGS_BASE_URL; the frontend's `tsc && vite build` type-checks src (browser lib, no node globals), so it needs @types/node or `process` is TS2580-undefined. */
const NODE_TYPES_VERSION = "^22.10.0";

const BINDINGS_LIVE_CONFIG = "vitest.bindings-live.config.ts";
const BINDINGS_LIVE_SETUP = "bindings-live.setup.ts";

const BINDINGS_LIVE_SETUP_SRC = `const baseUrl = process.env.BINDINGS_BASE_URL;
if (!baseUrl) {
  throw new Error(
    "BINDINGS_BASE_URL must point at the running backend for the live client-bindings tests",
  );
}

const passthroughFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  typeof input === "string" && input.startsWith("/")
    ? passthroughFetch(\`\${baseUrl}\${input}\`, init)
    : passthroughFetch(input, init)) as typeof globalThis.fetch;
`;

const BINDINGS_LIVE_CONFIG_SRC = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.bindings.live.ts"],
    setupFiles: ["./${BINDINGS_LIVE_SETUP}"],
    environment: "node",
    passWithNoTests: true,
  },
});
`;

interface PackageJsonPatch {
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
}

/** The add-if-absent `frontend/package.json` patch every frontend test generator needs so the generated `*.test.ts` files can run: `vitest` as a devDependency and a `test` script. Pass `needsZod` for the validators tests, whose imported `validators.ts` resolves `zod` at runtime. Deep-merged with the frontend_app skeleton and the client dependency patch, so a version already pinned wins. */
export function frontendTestHarnessPatch({
  needsZod = false,
}: { needsZod?: boolean } = {}): GenerateEntry {
  const patch: PackageJsonPatch = {
    devDependencies: { vitest: VITEST_VERSION },
    scripts: { test: "vitest run" },
  };
  if (needsZod) patch.dependencies = { zod: ZOD_VERSION };
  return {
    kind: PATCH,
    filename: join("frontend", "package.json"),
    content: JSON.stringify(patch),
  };
}

/** The frontend-root harness the live client-bindings tests need: a base-URL setup that rewrites the generated clients' relative `/api/...` fetches at `BINDINGS_BASE_URL` (a resolver, not a mock — real requests pass through to the running backend), a dedicated `passWithNoTests` vitest config whose `bindings.live.ts` include keeps these files out of the default `vitest run`, and a `test:bindings-live` script the verify runner invokes. Always generated, so a project with zero frontend bindings still has the script the verify step calls — it just runs zero live tests and passes. */
export function bindingsLiveHarnessEntries(): GenerateEntry[] {
  return [
    {
      kind: CONTENT,
      filename: join("frontend", BINDINGS_LIVE_SETUP),
      contents: BINDINGS_LIVE_SETUP_SRC,
    },
    {
      kind: CONTENT,
      filename: join("frontend", BINDINGS_LIVE_CONFIG),
      contents: BINDINGS_LIVE_CONFIG_SRC,
    },
    {
      kind: PATCH,
      filename: join("frontend", "package.json"),
      content: JSON.stringify({
        devDependencies: {
          vitest: VITEST_VERSION,
          "@types/node": NODE_TYPES_VERSION,
        },
        scripts: {
          "test:bindings-live": `vitest run --config ${BINDINGS_LIVE_CONFIG}`,
        },
      }),
    },
  ];
}
