import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { Emit } from "./emit.ts";
import { generate as generateViewTypeValidatorsTests } from "./generate-view-type-validators-tests.ts";
import { referencesBackend } from "./inline-inherited.ts";

/** Returns attributed entries. Cross-lane validator imports need host `finalizeEntries`. */
export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  const referenceBackendType = referencesBackend(ctx.settings);
  return generateViewTypeValidatorsTests(
    ctx,
    new Emit(ctx.settings).imports.frontend("src/validators"),
    referenceBackendType,
  );
};
