import { parse } from "yaml";
import {
  primaryBackendService,
  FRONTEND_SERVICE,
  FRONTEND_PORT,
} from "./compose-services.ts";
import { declaredLanguages } from "./declared-languages.ts";

/** The owner of a full-stack (`tier=all`) generate: it understands that a full app is a backend
 * (the requested languages) + a frontend (intrinsically TypeScript/React) + the client bindings
 * wiring them + a reverse proxy fronting both. Every planner and the proxy derive the run's shape
 * from here instead of restating it — so a rust backend can never silently drop the TS frontend,
 * and the proxy can never name a service the backend/frontend didn't generate. */

/** generator.application_tier_id: the Backend tier (the column default) whose per-language steps fan over the *requested* languages. Every other tier (Frontend = 2) is intrinsic to its own declared languages. */
const BACKEND_TIER_ID = 3;

interface Step {
  declaredLanguages: string[];
  applicationTierId?: number | null;
}

interface ComposeService {
  depends_on?: unknown;
}

interface ComposeDoc {
  services?: Record<string, ComposeService>;
}

function isBackendTier(applicationTierId?: number | null): boolean {
  return (applicationTierId ?? BACKEND_TIER_ID) === BACKEND_TIER_ID;
}

/** The languages a per-language step actually generates for. The requested `settings.languages` selects
 * the **backend lane only**: a backend-tier step fans over `requested ∩ declared`, but a
 * frontend/non-backend-tier step fans over its **own** declared languages (TypeScript) regardless of
 * the backend choice. This is the rule that keeps the frontend in a rust full-stack build. */
export function laneLanguagesForStep(
  step: Step,
  requestedLanguages: string[],
): string[] {
  const declared = step.declaredLanguages;
  if (isBackendTier(step.applicationTierId)) {
    return declared.filter((lang) => requestedLanguages.includes(lang));
  }
  return [...declared];
}

/** The reverse-proxy's two upstreams, derived from settings — the `/api` backend (primary declared
 * language, or `settings.other.proxy_backend`) and the `frontend` service. One source the proxy
 * reads so its `depends_on`/`proxy_pass` can't drift from what the lanes were named. */
export function resolveProxyTopology(settings: unknown) {
  const languages = declaredLanguages(
    settings as Parameters<typeof declaredLanguages>[0],
  );
  return {
    primaryBackend: primaryBackendService(
      languages,
      settings as Parameters<typeof primaryBackendService>[1],
    ),
    frontend: { service: FRONTEND_SERVICE, port: FRONTEND_PORT },
  };
}

/** Guard the full-stack contract at generate time: every compose service `depends_on` target must
 * be a service the run actually generated. Turns the class of "proxy references a service nobody
 * generated" bug into a loud throw naming the miss, instead of an invalid-compose failure that only
 * surfaces at `docker compose`. */
export function assertComposeDependenciesResolve(
  composeYamlText: string,
): void {
  const doc = parse(composeYamlText) as ComposeDoc | null | undefined;
  const services = doc?.services;
  if (!services || typeof services !== "object") return;
  const defined = new Set(Object.keys(services));
  for (const [name, service] of Object.entries(services)) {
    const deps = service?.depends_on;
    if (!Array.isArray(deps)) continue;
    for (const dep of deps) {
      if (!defined.has(dep)) {
        throw new Error(
          `invariant: compose service "${name}" depends on undefined service "${dep}" — the full-stack topology planned a proxy upstream the run never generated (defined services: ${[...defined].join(", ")})`,
        );
      }
    }
  }
}
