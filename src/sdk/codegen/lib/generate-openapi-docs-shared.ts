import { parse } from "yaml";
import { parseDatasourceTypes } from "./parse-datasource-types.ts";
import { buildEnrichedOpenApiSpec } from "./openapi-spec-build.ts";
import {
  CONTENT,
  type GenerateEntry,
} from "./generate-result.ts";
import { datasourceSettingsForSettings } from "./ts-datasource-settings.ts";

type SettingsArg = Parameters<typeof datasourceSettingsForSettings>[0];

interface OpenApiOverrides {
  title?: string;
  version?: string;
  naming?: string;
  schemaNaming?: string;
  groupByEntity?: boolean;
}

interface BuildFromDataOptions {
  routesData: unknown;
  viewData: unknown;
  datasourceData: unknown;
  settings: SettingsArg;
  overrides?: OpenApiOverrides;
}

interface DeterministicInputs {
  all(): Promise<{
    routesYamlText: string;
    viewYamlText: string;
    datasourceYamlText: string;
    datasourceSeedsYamlText: string | null;
  }>;
  dir: string;
}

interface GenerateOptions {
  inputs: DeterministicInputs;
  settings: SettingsArg;
}

/** The `create-openapi-docs` flag defaults — the openapi doc the pipeline actually generates (it passes none of these overrides). `groupByEntity` defaults true via the `!== false` check below. */
export const OPENAPI_DOC_DEFAULTS = Object.freeze({
  title: "Deterministic Backend API",
  version: "0.0.0",
  naming: "original",
  schemaNaming: "Snake",
});

/** Build the enriched OpenAPI doc from already-parsed contract data. Shared by the `openapi` catalog generator and the legacy `create-openapi-docs` CLI so the flag defaults and `settings`-derived knobs live in one place. `overrides` carries the CLI flag values (all optional; unset falls back to the default). */
export function buildOpenApiDocFromData({
  routesData,
  viewData,
  datasourceData,
  settings,
  overrides = {},
}: BuildFromDataOptions) {
  const ds = datasourceSettingsForSettings(settings);
  const buildArgs = {
    routesData,
    viewData,
    datasourceData,
    title: overrides.title ?? OPENAPI_DOC_DEFAULTS.title,
    version: overrides.version ?? OPENAPI_DOC_DEFAULTS.version,
    naming: overrides.naming ?? OPENAPI_DOC_DEFAULTS.naming,
    schemaNaming: overrides.schemaNaming ?? OPENAPI_DOC_DEFAULTS.schemaNaming,
    groupByEntity: overrides.groupByEntity !== false,
    useOptimisticConcurrency: ds.useOptimisticConcurrency,
    ds,
  };
  // buildEnrichedOpenApiSpec is an untyped .mjs whose `= null` defaults infer too narrowly; cast at the boundary
  return buildEnrichedOpenApiSpec(
    buildArgs as unknown as Parameters<typeof buildEnrichedOpenApiSpec>[0],
  );
}

/** Build the openapi doc from a `deterministic/` folder's raw YAMLs. Validation is the separate `validate` step's job — the catalog contract parses raw. */
export async function buildOpenApiDocFromInputs({
  inputs,
  settings,
}: GenerateOptions) {
  const {
    routesYamlText,
    viewYamlText,
    datasourceYamlText,
    datasourceSeedsYamlText,
  } = await inputs.all();
  return buildOpenApiDocFromData({
    routesData: parse(routesYamlText),
    viewData: parse(viewYamlText),
    datasourceData: parseDatasourceTypes(
      datasourceYamlText,
      settings,
      datasourceSeedsYamlText,
    ),
    settings,
  });
}

/** Shared `openapi` step (catalog sort_order 4): build the OpenAPI doc from the folder's routes + view + datasource YAMLs. Generated as a bare `openapi.json` CONTENT entry — the runner points `--output` at the `openapi/` dir (nested under `backend/` in combined mode), so the entry writes there like the SQL family, not via a magic root-shared prefix. */
export async function generate({
  inputs,
  settings,
}: GenerateOptions): Promise<{ entries: GenerateEntry[] }> {
  const doc = await buildOpenApiDocFromInputs({ inputs, settings });
  return {
    entries: [
      {
        kind: CONTENT,
        filename: "openapi.json",
        contents: `${JSON.stringify(doc, null, 2)}\n`,
      },
    ],
  };
}

export const entriesNative = true;
