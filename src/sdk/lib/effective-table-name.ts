import pluralize from "pluralize";

/** Apply `pluralize_datatable_names` to an entity's YAML key. Multi-token names are pluralized on the last token only (`backend_type` -> `backend_types`) so the singular tokens read as adjectives. Wraps the npm `pluralize` package, which is dictionary-backed and handles classical irregulars (man -> men, child -> children), already-plural words (analytics -> analytics, news -> news), and -f/-fe -> -ves (leaf -> leaves) that the homegrown rule-based pluralizer in `routes-expand.ts` gets wrong. */
export function effectiveTableName(
  name: string,
  pluralizeFlag: boolean,
): string {
  if (!pluralizeFlag) return name;
  if (!name) return name;
  const parts = String(name).split("_");
  parts[parts.length - 1] = pluralize(parts[parts.length - 1]);
  return parts.join("_");
}
