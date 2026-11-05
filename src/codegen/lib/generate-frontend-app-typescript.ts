import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../../sdk/codegen/lib/chunk-loader.ts";
import { PACK_TEMPLATES_DIR } from "../../pack-root.ts";
import {
  CONTENT,
  PATCH,
} from "../../sdk/codegen/lib/generate-result.ts";
import { COMBINED_FLAG } from "../../sdk/codegen/lib/backend-lane.ts";
import {
  FRONTEND_SERVICE,
  FRONTEND_PORT,
} from "../../sdk/codegen/lib/compose-services.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(PACK_TEMPLATES_DIR, "create-frontend-app");

const DEFAULT_APP_NAME = "generated-frontend";
const DEFAULT_LANGUAGE = "typescript";
const DEFAULT_FRAMEWORK = "React";

/** The single supported {language: framework} pair. framework already seeds React (typescript, Frontend tier) in datasource_types.yaml; this guard keeps the generator honest about what it can actually scaffold. */
const SUPPORTED_FRAMEWORK_BY_LANGUAGE: Record<string, string> = {
  typescript: "React",
};

/** Each template file → its path under the generated frontend/ subtree. Only index.html/App.tsx carry the {{appName}} token; the rest render verbatim. .gitignore and package.json are NOT here — each generates as a PATCH: .gitignore via the shared-append writer, package.json as the skeleton piece for the deep-merge writer so a later frontend-lane step (e.g. client_bindings) can add a dependency without last-writer-wins clobbering the manifest. */
const TEMPLATE_TO_OUTPUT: [string, string][] = [
  ["index.html", "index.html"],
  ["vite.config.ts", "vite.config.ts"],
  ["tsconfig.json", "tsconfig.json"],
  ["src/main.tsx", "src/main.tsx"],
  ["src/App.tsx.tmpl", "src/App.tsx"],
];

interface FrontendAppArgs {
  language?: string;
  framework?: string;
  combined?: boolean;
}

interface FrontendAppSettings {
  frontend?: { framework?: string };
  applicationName?: string;
}

interface FrontendAppInput {
  settings?: FrontendAppSettings;
  args?: FrontendAppArgs;
}

/** `--framework` is declared here so the runner (generate.mjs `profileFor`) merges it into the validated flag set for this step only — the sanctioned per-step extension, not a CANONICAL_FLAGS change. `--language` already rides the common flag set. */
export const flags = [
  {
    flag: "--framework",
    target: "framework",
    kind: "value",
    placeholder: "<name>",
    description: "Frontend framework to scaffold (React).",
  },
  COMBINED_FLAG,
];

function renderFrontendComposeService(): string {
  return `${FRONTEND_SERVICE}:
  build:
    context: .
    dockerfile: ./frontend/Dockerfile
  ports:
    - '\${FRONTEND_HOST_PORT:-${FRONTEND_PORT}}:${FRONTEND_PORT}'
`;
}

function renderFrontendDockerfile(): string {
  return `# syntax=docker/dockerfile:1
FROM node:26-alpine
WORKDIR /app
COPY frontend/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm install
COPY frontend/ ./
RUN npm run build
EXPOSE 5173
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "5173"]
`;
}

/** In combined (tier=all) generation the frontend needs a runnable compose service beside the backend + proxy: a `frontend` service (COMPOSE_SERVICE_FRONTEND section) built from a small frontend/Dockerfile that serves `vite preview` on 5173. Single-tier frontend generation stays byte-identical (this only runs under --combined). */
function frontendDeploymentEntries() {
  return [
    {
      kind: PATCH,
      filename: "docker-compose.yml",
      content: renderFrontendComposeService(),
      section: "COMPOSE_SERVICE_FRONTEND",
    },
    {
      kind: CONTENT,
      filename: join("frontend", "Dockerfile"),
      contents: renderFrontendDockerfile(),
    },
  ];
}

function assertSupported(language: string, framework: string): void {
  if (SUPPORTED_FRAMEWORK_BY_LANGUAGE[language] !== framework) {
    throw new Error(
      `frontend_app: unsupported { language: ${language}, framework: ${framework} } — only { typescript, React } is supported.`,
    );
  }
}

/** Scaffold a minimal React + Vite + TypeScript app under `frontend/`. Reads the merged settings.yaml (settings.frontend.framework + settings.application_name); `--framework` overrides the file, the file overrides the defaults. Throws on any {language, framework} outside the supported set so an unsupported request fails loudly instead of generating a broken app. */
export async function generate({ settings, args }: FrontendAppInput) {
  const language = args?.language ?? DEFAULT_LANGUAGE;
  const framework =
    args?.framework ?? settings?.frontend?.framework ?? DEFAULT_FRAMEWORK;
  assertSupported(language, framework);
  const appName = settings?.applicationName ?? DEFAULT_APP_NAME;

  const entries = [];
  for (const [templateFile, outputFile] of TEMPLATE_TO_OUTPUT) {
    const contents = await renderTemplate(resolve(templatesDir, templateFile), {
      appName,
    });
    entries.push({
      kind: CONTENT,
      filename: join("frontend", outputFile),
      contents,
    });
  }
  entries.push({
    kind: PATCH,
    filename: join("frontend", "package.json"),
    content: await renderTemplate(resolve(templatesDir, "package.json.tmpl"), {
      appName,
    }),
  });
  entries.push({
    kind: PATCH,
    filename: join("frontend", ".gitignore"),
    content: await renderTemplate(resolve(templatesDir, "gitignore"), {
      appName,
    }),
  });
  if (args?.combined === true) {
    entries.push(...frontendDeploymentEntries());
  }
  return { entries };
}

export const entriesNative = true;

/** A lone `generate --step frontend_app --output X` must compose its own PATCH pieces (package.json + frontend/.gitignore) immediately — otherwise they'd sit un-assembled under deterministic/patches/. Fires only on that standalone single-step path; `generate --all --tier frontend`, the `--assemble` orchestration, and the in-process server path all run frontend_app through runOneStep and assemble once at the end, so this flag never fires there. */
export const assembleAfterStep = true;
