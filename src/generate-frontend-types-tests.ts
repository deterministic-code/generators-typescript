import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { Emit } from "./emit.ts";
import { generate as generateViewTypesTests } from "./generate-view-types-tests.ts";
import { referencesBackend } from "./inline-inherited.ts";

/** Returns attributed entries. Cross-lane type imports need host `finalizeEntries`. */
export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  const referenceBackendType = referencesBackend(ctx.settings);
  return generateViewTypesTests(
    ctx,
    new Emit(ctx.settings).imports.frontend("src/types"),
    referenceBackendType,
  );
};
