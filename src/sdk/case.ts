import npmPluralize from "pluralize";
import { camelCase, pascalCase, snakeCase, kebabCase } from "change-case";

export type CaseFormat = "Camel" | "Pascal" | "Snake" | "Kebab" | "Auto";

export interface LanguageCasing {
  fileFormat: CaseFormat;
  classFormat: CaseFormat;
  fieldFormat: CaseFormat;
  dirFormat: CaseFormat;
}

type LanguageKey =
  | "typescript"
  | "javascript"
  | "python"
  | "java"
  | "csharp"
  | "rust";

export const CASE_FORMATS: readonly CaseFormat[] = [
  "Camel",
  "Pascal",
  "Snake",
  "Kebab",
  "Auto",
];

export const LANGUAGE_CASING_CONVENTIONS: Record<LanguageKey, LanguageCasing> =
  {
    typescript: {
      fileFormat: "Kebab",
      classFormat: "Pascal",
      fieldFormat: "Snake",
      dirFormat: "Kebab",
    },
    javascript: {
      fileFormat: "Kebab",
      classFormat: "Pascal",
      fieldFormat: "Snake",
      dirFormat: "Kebab",
    },
    python: {
      fileFormat: "Snake",
      classFormat: "Pascal",
      fieldFormat: "Snake",
      dirFormat: "Snake",
    },
    java: {
      fileFormat: "Pascal",
      classFormat: "Pascal",
      fieldFormat: "Camel",
      dirFormat: "Pascal",
    },
    csharp: {
      fileFormat: "Pascal",
      classFormat: "Pascal",
      fieldFormat: "Pascal",
      dirFormat: "Pascal",
    },
    rust: {
      fileFormat: "Snake",
      classFormat: "Pascal",
      fieldFormat: "Snake",
      dirFormat: "Snake",
    },
  };

const LANGUAGE_ALIASES: Record<string, LanguageKey> = {
  ts: "typescript",
  typescript: "typescript",
  js: "javascript",
  javascript: "javascript",
  py: "python",
  python: "python",
  cs: "csharp",
  csharp: "csharp",
  "c#": "csharp",
  java: "java",
  rs: "rust",
  rust: "rust",
};

function normalizeCasingLanguage(
  raw: string | null | undefined,
): LanguageKey | null {
  if (!raw) return null;
  const key = String(raw)
    .toLowerCase()
    .replace(/[\s_\-]/g, "");
  return LANGUAGE_ALIASES[key] ?? null;
}

export function resolveAutoCasing(
  language: string,
  options: LanguageCasing,
): LanguageCasing {
  const key = normalizeCasingLanguage(language);
  if (!key) {
    throw new Error(
      `resolveAutoCasing: unknown language "${language}". Valid: ${Object.keys(LANGUAGE_CASING_CONVENTIONS).join(", ")}.`,
    );
  }
  const conventions = LANGUAGE_CASING_CONVENTIONS[key];
  const out: LanguageCasing = { ...options };
  if (out.fileFormat === "Auto") out.fileFormat = conventions.fileFormat;
  if (out.classFormat === "Auto") out.classFormat = conventions.classFormat;
  if (out.fieldFormat === "Auto") out.fieldFormat = conventions.fieldFormat;
  if (out.dirFormat === "Auto") out.dirFormat = conventions.dirFormat;
  return out;
}

export function tokenize(name: string): string[] {
  return snakeCase(name)
    .split("_")
    .filter((s) => s.length > 0);
}

export function toCase(name: string, format: CaseFormat): string {
  switch (format) {
    case "Camel":
      return camelCase(name);
    case "Pascal":
      return pascalCase(name);
    case "Snake":
      return snakeCase(name);
    case "Kebab":
      return kebabCase(name);
    default:
      throw new Error(
        `Unknown case format: ${format}. Valid: ${CASE_FORMATS.join(", ")}.`,
      );
  }
}

export function kebab(name: string): string {
  return toCase(name, "Kebab");
}

export function snake(name: string): string {
  return toCase(name, "Snake");
}

export function pascal(name: string): string {
  return toCase(name, "Pascal");
}

export function kebabToSnake(name: string): string {
  return name.replace(/-/g, "_");
}

const CASE_VARIANT_FORMATS: readonly CaseFormat[] = [
  "Camel",
  "Pascal",
  "Snake",
  "Kebab",
];

export function caseVariantsOf(name: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const format of CASE_VARIANT_FORMATS) {
    const v = toCase(name, format);
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function snakeToCamel(name: string): string {
  return name
    .split(/[_-]/)
    .map((part, i) => (i === 0 ? part : cap(part)))
    .join("");
}

export function snakeToPascal(name: string): string {
  return cap(snakeToCamel(name));
}

export function snakeToKebab(name: string): string {
  return name.replace(/_/g, "-");
}

export function camelToSnake(name: string): string {
  return toCase(name, "Snake");
}

export function pluralize(word: string): string {
  return npmPluralize.plural(word);
}

export function kebabPlural(name: string): string {
  const kebabName = snakeToKebab(name);
  const parts = kebabName.split("-");
  parts[parts.length - 1] = pluralize(parts[parts.length - 1]);
  return parts.join("-");
}

export function apiPathSegment(entity: string): string {
  return kebabPlural(entity).replace(/_/g, "-");
}

export function camelPlural(entity: string): string {
  return snakeToCamel(kebabPlural(entity).replace(/-/g, "_"));
}
