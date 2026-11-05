import {
  DEV_PORTS,
  deriveCSharpProjectName,
} from "../../create-backend-app-model.ts";

interface ComposeServiceOptions {
  serviceName: string;
  portEnvVar: string;
  defaultPort: number;
  environment: string[];
  healthcheckComment?: string | null;
  healthcheckTest: string;
  retries: number;
  startPeriod: string;
  label?: string | null;
  dockerfilePath?: string | null;
  extraHosts?: string[];
}

function dockerfileField(dockerfilePath: string | null): string {
  return dockerfilePath ? `\n    dockerfile: ${dockerfilePath}` : "";
}

// Passes the host's DETERMINISTIC_TRACE through to the container so the generated app's generic env→middleware-enable channel (parseEnableMiddlewareEnv / parse_enable_middleware_env) works in docker; the empty `:-` default keeps production containers unchanged until an operator (or verify) sets it, and any registered middleware name — not just the route/service/datasource trace tiers — can be enabled through it.
const TRACE_ENV_LIST = "- DETERMINISTIC_TRACE=${DETERMINISTIC_TRACE:-}";
const TRACE_ENV_MAP = "DETERMINISTIC_TRACE: '${DETERMINISTIC_TRACE:-}'";

function renderComposeService({
  serviceName,
  portEnvVar,
  defaultPort,
  environment,
  healthcheckComment = null,
  healthcheckTest,
  retries,
  startPeriod,
  label = null,
  dockerfilePath = null,
  extraHosts = [],
}: ComposeServiceOptions): string {
  const environmentBlock = environment.map((line) => `    ${line}\n`).join("");
  const extraHostsBlock =
    extraHosts.length > 0
      ? `  extra_hosts:\n${extraHosts.map((h) => `    - '${h}'`).join("\n")}\n`
      : "";
  const commentBlock = healthcheckComment
    ? `    # ${healthcheckComment}\n`
    : "";
  const labelsBlock = label
    ? `  labels:\n    - 'deterministic.language=${label}'\n`
    : "";
  return `${serviceName}:
  build:
    context: .${dockerfileField(dockerfilePath)}
  ports:
    - '\${${portEnvVar}:-${defaultPort}}:4000'
  environment:
${environmentBlock}${extraHostsBlock}  healthcheck:
${commentBlock}    test: ${healthcheckTest}
    interval: 5s
    timeout: 3s
    retries: ${retries}
    start_period: ${startPeriod}
${labelsBlock}`;
}

const TYPESCRIPT_SPEC = {
  serviceName: "app",
  portEnvVar: "HOST_PORT",
  defaultPort: DEV_PORTS.typescript,
  environment: ["- NODE_ENV=production", "- PORT=4000", TRACE_ENV_LIST],
  healthcheckComment:
    "Self-diagnosing: logs `HTTP <code>` on response, an error code (ECONNREFUSED/ENOTFOUND/…) on connect failure, or `timeout` on a hung socket — without this, a failed probe shows up as `(no output)` in the verify dialog.",
  healthcheckTest: `['CMD', 'node', '-e', "const r=require('http').get('http://localhost:4000/api/health',{timeout:2500},(res)=>{console.log('HTTP',res.statusCode);process.exit(res.statusCode===200?0:1)});r.on('error',(e)=>{console.error(e.code||e.message);process.exit(1)});r.on('timeout',()=>{console.error('timeout');r.destroy();process.exit(1)})"]`,
  retries: 6,
  startPeriod: "5s",
  label: "typescript",
};

// why service named `rust` (not `app`) and RUST_HOST_PORT (not HOST_PORT): verify's docker_*_rust steps hardcode the `rust` target, and TS owns HOST_PORT when both services share one compose file.
const RUST_MULTI_SPEC = {
  serviceName: "rust",
  portEnvVar: "RUST_HOST_PORT",
  defaultPort: DEV_PORTS.rust,
  environment: ["PORT: '4000'", TRACE_ENV_MAP],
  healthcheckTest: `['CMD', 'curl', '-fsS', 'http://localhost:4000/api/health']`,
  retries: 12,
  startPeriod: "10s",
  label: "rust",
};

// RUST_HOST_PORT (not HOST_PORT): verify leases a distinct host port per lane and passes the rust lane's port in RUST_HOST_PORT (verify-app-service allocatePorts + runDockerUpRustStep + smoke-test-rust). Reading HOST_PORT made the rust lane bind the TS lane's port, so both `docker compose up` calls collided on one host port ("Bind for 0.0.0.0:<port> failed: port is already allocated"). DETERMINISTIC_DIR is baked because the standalone image bundles deterministic/ into /app (post-codegen images bake both into the entrypoint instead).
const RUST_STANDALONE_SPEC = {
  serviceName: "rust",
  portEnvVar: "RUST_HOST_PORT",
  defaultPort: DEV_PORTS.rust,
  environment: [
    "PORT: '4000'",
    "DETERMINISTIC_DIR: /app/deterministic",
    TRACE_ENV_MAP,
  ],
  healthcheckTest: `['CMD-SHELL', "curl -fsS -o /dev/null -w 'HTTP %{http_code}\\n' http://localhost:4000/api/health || (echo 'probe failed' && exit 1)"]`,
  retries: 12,
  startPeriod: "10s",
};

const CSHARP_MULTI_SPEC = {
  serviceName: "csharp",
  portEnvVar: "CSHARP_HOST_PORT",
  defaultPort: DEV_PORTS.csharp,
  environment: ["ASPNETCORE_URLS: 'http://+:4000'"],
  healthcheckTest: `['CMD', 'curl', '-fsS', 'http://localhost:4000/api/health']`,
  retries: 12,
  startPeriod: "10s",
  label: "csharp",
};

// single-lang C# keeps its project-derived service name so existing docker tooling that targets it stays valid.
const CSHARP_SINGLE_SPEC = {
  portEnvVar: "HOST_PORT",
  defaultPort: DEV_PORTS.csharp,
  environment: [
    "- ASPNETCORE_ENVIRONMENT=Production",
    "- ASPNETCORE_URLS=http://+:4000",
  ],
  healthcheckTest: `['CMD-SHELL', 'curl -fsS http://localhost:4000/api/health || exit 1']`,
  retries: 6,
  startPeriod: "5s",
};

export const COMPOSE_FILENAME = "docker-compose.yml";

/** The compose service name of the generated frontend lane (generate-frontend-app-typescript.ts), and its in-container port. The single source both the frontend generator and the reverse proxy read so the proxy's `frontend` reference can never drift from what the frontend service is actually named. */
export const FRONTEND_SERVICE = "frontend";
export const FRONTEND_PORT = 5173;

// The in-container port every backend lane listens on (compose maps a leased host port to it); the reverse proxy always targets `<service>:4000` regardless of language.
const BACKEND_PORT = 4000;

// Backend-language → generated compose service name, the same names renderTypescriptComposeService/renderRustComposeService/renderCSharpComposeService produce. C#'s single-language service is project-derived, but a full-stack build nests every backend under backend/<lang>/ and uses the language-named service so the proxy can find it.
const BACKEND_SERVICE_NAMES: Record<string, string> = {
  typescript: "app",
  rust: "rust",
  csharp: "csharp",
};

/** The compose service name for a backend language — the one place the topology, the proxy, and any depends_on derive it, instead of restating `app`/`rust`. Throws on an unknown language so a new backend can't silently mis-wire the proxy. */
function backendServiceName(language: string): string {
  const name = BACKEND_SERVICE_NAMES[language];
  if (!name) {
    throw new Error(
      `invariant: no compose service name registered for backend language '${language}'`,
    );
  }
  return name;
}

interface ComposeSettings {
  other?: { proxyBackend?: string } | null;
}

/** The `<service>:<port>` the reverse proxy routes `/api` to: the primary backend service. Primary = `settings.other.proxy_backend` when set, else the first declared backend language. Throws when a full-stack build declares no backend language to front. */
export function primaryBackendService(
  languages: string[],
  settings?: ComposeSettings | null,
) {
  const override = settings?.other?.proxyBackend;
  const primary = override ?? languages[0];
  if (!primary) {
    throw new Error(
      "invariant: full-stack build has no backend language for the reverse proxy to front",
    );
  }
  return { service: backendServiceName(primary), port: BACKEND_PORT };
}

export function renderTypescriptComposeService({
  dockerfilePath = null,
}: { dockerfilePath?: string | null } = {}): string {
  return renderComposeService({ ...TYPESCRIPT_SPEC, dockerfilePath });
}

export function renderRustComposeService({
  dockerfilePath = null,
}: { dockerfilePath?: string | null } = {}): string {
  return renderComposeService({ ...RUST_MULTI_SPEC, dockerfilePath });
}

export function renderRustStandaloneComposeService({
  extraHosts = [],
}: { extraHosts?: string[] } = {}): string {
  return renderComposeService({ ...RUST_STANDALONE_SPEC, extraHosts });
}

export function renderCSharpComposeService({
  dockerfilePath = null,
}: { dockerfilePath?: string | null } = {}): string {
  return renderComposeService({ ...CSHARP_MULTI_SPEC, dockerfilePath });
}

export function renderCSharpSingleComposeService(model: {
  projectName?: string;
  appName?: string;
}): string {
  return renderComposeService({
    ...CSHARP_SINGLE_SPEC,
    serviceName: deriveCSharpProjectName(model).toLowerCase(),
  });
}
