import type { ParsedSettings } from "../../read-settings.ts";
import { parse } from "yaml";
import { parseDatasourceTypes } from "./parse-datasource-types.ts";
import {
  datasourceDirective,
  expandViewTypes,
} from "../../view-expand.ts";
import type { RawTypesDoc } from "../../deterministic-shapes.ts";
import { configKnobsFromSettings } from "./generate-settings-options.ts";

interface ViewGenerateConfigInput {
  language: string;
  viewYamlText: string;
  datasourceYamlText: string;
  settings: ParsedSettings;
}

export interface ViewGenerateContext {
  inputs: {
    all(): Promise<{ viewYamlText: string; datasourceYamlText: string }>;
  };
  settings: ParsedSettings;
}

/** Build the generate config every view step (`view_types` / `view_type_validators` / `view_types_tests`) hands its language generator: parse the assumed-valid view + datasource YAML texts, expand the view against the datasource, and merge the settings-driven knobs — mirroring the legacy `dispatchViewStep` config. A missing datasource file defaults to `{ types: [] }`, and a view whose `includes:` carries a datasource_types directive without one is malformed and throws. */
function buildViewGenerateConfig({
  language,
  viewYamlText,
  datasourceYamlText,
  settings,
}: ViewGenerateConfigInput): Record<string, unknown> {
  const viewData = parse(viewYamlText);
  const datasourceData = datasourceYamlText
    ? parseDatasourceTypes(datasourceYamlText, settings)
    : { types: [] };
  if (!datasourceYamlText && datasourceDirective(viewData)) {
    throw new Error(
      "view_types.yaml declares an includes datasource_types directive but no datasource_types.yaml was provided.",
    );
  }
  return {
    language,
    viewTypes: expandViewTypes(viewData, datasourceData as RawTypesDoc),
    datasourceTypes: datasourceData,
    datasource: datasourceData,
    settings,
    ...configKnobsFromSettings(settings, language),
  };
}

/** Build a self-describing catalog-runner `generate` for one view step: read the whole-dir inputs and render via the language generator's `createGenerator`. The generated paths are output-root-relative (bare when flat, `features/<dir>/` under by-feature); the runner's `--output` (from `outputFor`) supplies the step's artifact directory, so the generator never re-prefixes it. The nine `generate-view-*.mjs` modules each export `makeViewGenerate(createGenerator, step, language)` so the wrapper body lives once. */
export function makeViewGenerate<C>(
  createGenerator: () => { generate: (config: C) => unknown },
  _step: string,
  language: string,
) {
  return async function generate({ inputs, settings }: ViewGenerateContext) {
    const { viewYamlText, datasourceYamlText } = await inputs.all();
    const config = buildViewGenerateConfig({
      language,
      viewYamlText,
      datasourceYamlText,
      settings,
    });
    // dynamic loader→SDK boundary: the built config bag is the generator's own config shape.
    const files = createGenerator().generate(config as unknown as C);
    return { files };
  };
}
