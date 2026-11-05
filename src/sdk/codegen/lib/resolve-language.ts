import { DEFAULT_LANGUAGE } from "../../lib/codegen-steps-constants.ts";

interface ResolveArgs {
  language?: string;
}

interface ResolveSettings {
  backend?: { languages?: string[] };
}

interface ResolveLanguageOptions {
  defaultLanguage?: string;
  supportedLanguages?: string[];
  validLanguages?: string[];
}

interface MakeResolvedLanguageOptions {
  validLanguages?: string[];
  supportedLanguages?: string[];
  defaultLanguage?: string;
}

export function makeResolvedLanguage({
  validLanguages,
  supportedLanguages,
  defaultLanguage = DEFAULT_LANGUAGE,
}: MakeResolvedLanguageOptions) {
  return (args: ResolveArgs | null, settings: ResolveSettings | null) =>
    resolveLanguage(args, settings, {
      defaultLanguage,
      validLanguages,
      supportedLanguages,
    });
}

function resolveDeclaredLanguage(
  settings: ResolveSettings | null,
  opts: ResolveLanguageOptions,
): string | undefined {
  const { defaultLanguage, supportedLanguages } = opts;
  const declared = settings?.backend?.languages ?? [];
  const candidates = Array.isArray(supportedLanguages)
    ? declared.filter((l) =>
        supportedLanguages.some((s) => s.toLowerCase() === l.toLowerCase()),
      )
    : declared;
  if (candidates.length === 0) return defaultLanguage;
  if (candidates.length === 1) return candidates[0];
  throw new Error(
    `--language must be specified: settings.backend.languages has multiple entries [${declared.join(", ")}]; refusing to silently pick one. Pass --language <lang>.`,
  );
}

export function resolveLanguage(
  args: ResolveArgs | null,
  settings: ResolveSettings | null,
  opts: ResolveLanguageOptions = {},
): string | undefined {
  const { validLanguages } = opts;
  const raw =
    args && args.language
      ? args.language
      : resolveDeclaredLanguage(settings, opts);
  if (Array.isArray(validLanguages)) {
    const lowered = String(raw).toLowerCase();
    if (!validLanguages.includes(lowered)) {
      throw new Error(
        `unknown language "${raw}"; valid: ${validLanguages.join(", ")}`,
      );
    }
    return lowered;
  }
  return raw;
}
