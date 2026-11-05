/** The subdirectory backend-tier per-language output nests under, as a trailing-slashed prefix (`""` when flat). Combined generation (`tier=all`) isolates the backend app in `backend/` so it sits beside the frontend's `frontend/`; multi-language generation nests each lane under `<lang>/`. The two compose: a combined multi-language backend lands under `backend/<lang>/`. Backend-shared trees (sql/, openapi/) also nest under `backend/` in combined mode; only `deterministic/` and the root orchestration (docker-compose.yml, reverse-proxy config, the root .dockerignore) stay at the run root. */
export function backendLaneDir({
  combined = false,
  multiLanguage = false,
  language,
}: {
  combined?: boolean;
  multiLanguage?: boolean;
  language: string;
}): string {
  const parts: string[] = [];
  if (combined) parts.push("backend");
  if (multiLanguage) parts.push(language);
  return parts.length > 0 ? `${parts.join("/")}/` : "";
}
