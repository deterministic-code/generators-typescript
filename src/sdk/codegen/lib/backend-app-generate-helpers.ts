type BackendAppDriver = (opts: {
  input: string;
  language: string;
  combined: boolean;
}) => Promise<unknown>;

export interface BackendAppGenerateContext {
  inputs: { dir: string };
  args?: { combined?: boolean };
}

/** Build a self-describing catalog-runner `generate` for a `backend_app` language: hand the language's whole-scaffold driver the resolved input dir. The driver reads its own settings + YAML from that dir and returns a CONTENT + PATCH entry mix, so each module also exports `entriesNative = true`. The driver is a local closure, never captured across an import cycle. */
export function makeBackendAppGenerate(driver: BackendAppDriver, language: string) {
  return async function generate({ inputs, args }: BackendAppGenerateContext) {
    return {
      entries: await driver({
        input: inputs.dir,
        language,
        combined: args?.combined === true,
      }),
    };
  };
}
