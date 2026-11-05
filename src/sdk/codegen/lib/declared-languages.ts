interface LanguageSettings {
  backend?: { languages?: unknown };
}

/** The project's declared target languages, read from `settings.backend.languages` and lowercased to the canonical generate form (the YAML authors them capitalized, e.g. `TypeScript`). This — not the transient `--language`/`--languages` of one invocation — is the durable source of truth for the output layout: a project *declaring* ≥2 languages nests each lane under `<root>/<lang>/` even when the languages are generated one at a time, so separate single-language runs no longer clobber each other at the flat root. */
export function declaredLanguages(settings?: LanguageSettings): string[] {
  const list = settings?.backend?.languages;
  return Array.isArray(list) ? list.map((lang) => lang.toLowerCase()) : [];
}

/** Whether the project declares more than one target language, so per-language output must nest under `<lang>/` regardless of how many languages a single invocation generates. */
export function isMultiLanguage(settings?: LanguageSettings): boolean {
  return declaredLanguages(settings).length > 1;
}
