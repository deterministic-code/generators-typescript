import type { ParsedSettings } from "../../read-settings.ts";
import { parseDatasourceTypes } from "./parse-datasource-types.ts";
import { configKnobsFromSettings } from "./generate-settings-options.ts";

export interface DatasourceGenerateContext {
  inputs: { all(): Promise<{ datasourceYamlText: string }> };
  settings: ParsedSettings;
}

/** Build a self-describing catalog-runner `generate` for a datasource step (types / validators / tests): read the datasource YAML from the folder inputs and render via the language generator's `createGenerator`. The generated paths are output-root-relative (bare when flat, `features/<dir>/` under by-feature); the runner's `--output` (from `outputFor`) supplies the step's artifact directory. Mirrors `makeViewGenerate`. */
export function makeDatasourceGenerate<C>(
  createGenerator: () => { generate: (config: C) => unknown },
  language: string,
) {
  return async function generate({ inputs, settings }: DatasourceGenerateContext) {
    const { datasourceYamlText } = await inputs.all();
    const config = {
      language,
      datasourceTypes: parseDatasourceTypes(datasourceYamlText, settings),
      settings,
      ...configKnobsFromSettings(settings, language),
    };
    // dynamic loader→SDK boundary: the built config bag is the generator's own config shape.
    const files = createGenerator().generate(config as unknown as C);
    return { files };
  };
}
