import type { ParsedSettings } from "../../read-settings.ts";
interface CatalogInputs {
  all(): Promise<Record<string, string>>;
}

interface CatalogContext {
  inputs: CatalogInputs;
  settings: ParsedSettings;
}

/** The standard-inputs bag `catalogStepGenerate` hands the family dispatcher: the primary YAML as `yamlText`, the resolved siblings, settings, and the fixed language override. */
interface CatalogStepInput {
  yamlText: string;
  viewYamlText: string;
  datasourceYamlText: string;
  datasourceSeedsYamlText: string | null;
  routesYamlText: string;
  servicesYamlText: string;
  settings: ParsedSettings;
  overrides: { language: string };
}

interface StepConfig<E> {
  dispatchStep: (generator: E) => (config: CatalogStepInput) => unknown;
  generator: E;
  language: string;
  primary: string;
}

/** Adapt a create-scripts family dispatcher to the catalog `{ inputs, settings }` contract for a fixed language. Reads the whole `deterministic/` folder and hands the dispatcher the standard inputs with `primary` (the step's own YAML key, e.g. `servicesYamlText` or `routesYamlText`) as `yamlText`; the dispatcher's own `resolveStepInputs` picks the siblings it needs and ignores the rest. Build the config bag inside the render module's `generate` arrow so `dispatchStep`/`generators` deref at call time — import-cycle-safe. */
export async function catalogStepGenerate<E>(
  { dispatchStep, generator, language, primary }: StepConfig<E>,
  { inputs, settings }: CatalogContext,
) {
  const all = await inputs.all();
  return dispatchStep(generator)({
    yamlText: all[primary],
    viewYamlText: all.viewYamlText,
    datasourceYamlText: all.datasourceYamlText,
    datasourceSeedsYamlText: all.datasourceSeedsYamlText,
    routesYamlText: all.routesYamlText,
    servicesYamlText: all.servicesYamlText,
    settings,
    overrides: { language },
  });
}
