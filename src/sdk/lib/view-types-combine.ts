import { parse, stringify } from "yaml";
import {
  applyEntryOptions,
  assertCombine,
  duplicateNames,
} from "./types-combine-core.ts";

type SideOptionsArg = Parameters<typeof applyEntryOptions>[1];
type ViewEntry = Parameters<typeof applyEntryOptions>[0][number];
type DatasourceDoc = unknown;

interface CombineOptions {
  source?: SideOptionsArg;
  destination?: SideOptionsArg;
  datasourceData?: DatasourceDoc;
}

function viewFieldsOf(def: unknown): ViewEntry[] | null {
  const fields = (def as { fields?: unknown })?.fields;
  return Array.isArray(fields) ? (fields as ViewEntry[]) : null;
}

/**
 * Apply a side's transform options to a parsed view_types document. Pure: the
 * input is deep-cloned, never mutated. Field ops targeting a union view (no
 * `fields`) resolve to an unknown target rather than throwing.
 */
export function applyViewSideOptions(
  data: { types?: unknown } | null | undefined,
  sideOptions: SideOptionsArg = {},
  side = "source",
) {
  const types = structuredClone((data?.types ?? []) as ViewEntry[]);
  const { unknownTargets } = applyEntryOptions(types, sideOptions, {
    side,
    fieldsOf: viewFieldsOf,
  });
  return { data: { types }, unknownTargets };
}

function buildCombined(
  sourceYaml: string,
  destYaml: string,
  options: CombineOptions,
) {
  const sourceDoc = parse(sourceYaml) ?? {};
  const destDoc = parse(destYaml) ?? {};
  const source = applyViewSideOptions(sourceDoc, options.source, "source");
  const destination = applyViewSideOptions(
    destDoc,
    options.destination,
    "destination",
  );

  const version = destDoc.version ?? sourceDoc.version;
  const combined = {
    ...(version !== undefined ? { version } : {}),
    types: [...source.data.types, ...destination.data.types],
  };
  const report = {
    duplicateTypes: duplicateNames(source.data.types, destination.data.types),
    invalidReferences: [] as { instancePath: string; message: string }[],
    unknownOptionTargets: [
      ...source.unknownTargets,
      ...destination.unknownTargets,
    ],
  };
  return { combined, report };
}

/**
 * Compute the merge report (duplicate view names, invalid datasource
 * references, unresolved option targets) WITHOUT asserting. `options` carries
 * the per-side transforms (`source`/`destination`) plus an optional
 * `datasourceData` (the merged datasource model); omit it and `invalidReferences`
 * stays empty. Throws only on unparseable YAML.
 */
export function reportCombineViewTypes(
  sourceYaml: string,
  destYaml: string,
  options: CombineOptions = {},
) {
  return buildCombined(sourceYaml, destYaml, options).report;
}

/**
 * Combine two view_types.yaml documents into one. Applies each side's transform
 * options, concatenates source-then-destination views, and asserts: throws if a
 * view name still overlaps, an `inherits`/reference points at an unknown
 * datasource type/field (checked when `options.datasourceData` is present), or
 * an option target didn't resolve. Only the merged `types:` are generated — an
 * `includes:` block is not carried (the resolver owns it). Returns the combined
 * YAML string and the report.
 */
export function combineViewTypes(
  sourceYaml: string,
  destYaml: string,
  options: CombineOptions = {},
) {
  const { combined, report } = buildCombined(sourceYaml, destYaml, options);
  assertCombine(report, "view_types");
  return { yaml: stringify(combined), report };
}
