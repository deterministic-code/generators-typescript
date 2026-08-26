import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { BUNDLED_LIBRARY_MODE } from "./generated-app.ts";

export const CONTACTS_FIXTURE_DIR = fileURLToPath(
  new URL("./samples/contacts/deterministic/", import.meta.url),
);

export type ContactsVariantId =
  | "baseline"
  | "by-feature-pascal"
  | "occ-snake"
  | "singular-camel"
  | "snake-test";

export type ContactsVariant = {
  id: ContactsVariantId;
  organizeByFeature: boolean;
  useOptimisticConcurrency: boolean;
  pluralizeDatatableNames: boolean;
  fileNames: string;
  types: string;
};

export const CONTACTS_VARIANTS: Record<ContactsVariantId, ContactsVariant> = {
  baseline: {
    id: "baseline",
    organizeByFeature: false,
    useOptimisticConcurrency: false,
    pluralizeDatatableNames: true,
    fileNames: "kebab",
    types: "pascal",
  },
  "by-feature-pascal": {
    id: "by-feature-pascal",
    organizeByFeature: true,
    useOptimisticConcurrency: false,
    pluralizeDatatableNames: true,
    fileNames: "pascal",
    types: "pascal",
  },
  "occ-snake": {
    id: "occ-snake",
    organizeByFeature: false,
    useOptimisticConcurrency: true,
    pluralizeDatatableNames: true,
    fileNames: "snake",
    types: "pascal",
  },
  "singular-camel": {
    id: "singular-camel",
    organizeByFeature: false,
    useOptimisticConcurrency: false,
    pluralizeDatatableNames: false,
    fileNames: "camel",
    types: "camel",
  },
  "snake-test": {
    id: "snake-test",
    organizeByFeature: false,
    useOptimisticConcurrency: false,
    pluralizeDatatableNames: true,
    fileNames: "snake",
    types: "snake",
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asMapping = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error("contacts settings.yaml: expected a mapping");
  }
  return value;
};

const mappingAt = (
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const child = parent[key];
  if (child === undefined) {
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
  }
  return asMapping(child);
};

const flattenValue = (
  value: unknown,
  prefix: string,
  out: Record<string, string>,
): void => {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    if (prefix !== "") out[prefix] = value.map(String).join(",");
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenValue(child, prefix === "" ? key : `${prefix}.${key}`, out);
    }
    return;
  }
  if (prefix !== "") out[prefix] = String(value);
};

const overlaySettingsDoc = (
  doc: Record<string, unknown>,
  variant: ContactsVariant,
): Record<string, unknown> => {
  const settings = mappingAt(doc, "settings");
  settings.application_name = `contacts-${variant.id}`;
  const datasource = mappingAt(settings, "datasource");
  datasource.use_optimistic_concurrency = variant.useOptimisticConcurrency;
  datasource.pluralize_datatable_names = variant.pluralizeDatatableNames;
  const other = mappingAt(settings, "other");
  other.organize_by_feature = variant.organizeByFeature;
  const backend = mappingAt(settings, "backend");
  backend.languages = ["typescript"];
  backend.datasources = ["sqlite"];
  const languages = mappingAt(settings, "languages");
  const typescript = mappingAt(languages, "typescript");
  typescript.library_reference_mode = "bundled";
  const casing = mappingAt(typescript, "casing");
  casing.file_names = variant.fileNames;
  casing.types = variant.types;
  return doc;
};

const flattenSettings = (
  doc: Record<string, unknown>,
  variant: ContactsVariant,
): Record<string, string> => {
  const flat: Record<string, string> = {};
  flattenValue(doc["settings"], "", flat);
  return {
    ...flat,
    application_name: `contacts-${variant.id}`,
    app_generate_complexity: "deterministic",
    frontend_generate_framework: "vite",
    "backend.datasources": "sqlite",
    "backend.languages": "typescript",
    "paths.deterministic": CONTACTS_FIXTURE_DIR,
    ...BUNDLED_LIBRARY_MODE,
  };
};

const loadYamlTree = async (
  dir: string,
  prefix = "",
): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(out, await loadYamlTree(join(dir, entry.name), rel));
      continue;
    }
    if (!entry.name.endsWith(".yaml")) continue;
    out[rel] = await readFile(join(dir, entry.name), "utf8");
  }
  return out;
};

export type ContactsSample = {
  variant: ContactsVariant;
  yaml: Record<string, string>;
  settings: Record<string, string>;
};

export const loadContactsSample = async (
  variant: ContactsVariant,
): Promise<ContactsSample> => {
  const yaml = await loadYamlTree(CONTACTS_FIXTURE_DIR);
  const settingsText = yaml["settings.yaml"];
  if (settingsText === undefined) {
    throw new Error("contacts fixture missing settings.yaml");
  }
  const doc = overlaySettingsDoc(asMapping(parse(settingsText)), variant);
  yaml["settings.yaml"] = stringify(doc);
  return { variant, yaml, settings: flattenSettings(doc, variant) };
};
