import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { verifyEntries } from "@deterministic-code/generators-common/reference-verifier";
import { Emit } from "./emit.ts";
import { generateViewTypes } from "./emit-shaped-types.ts";
import { referencesBackend } from "./inline-inherited.ts";

/** Self-checks when the lane is closed; backend-type refs need host `finalizeEntries`. */
export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  const referenceBackendType = referencesBackend(ctx.settings);
  const views = new Emit(ctx.settings).imports.frontend("src/types");
  const entries = await generateViewTypes(ctx, {
    referenceBackendType,
    basePath: views,
    datasourceBasePath: referenceBackendType
      ? "types/generated/datasource"
      : views,
  });
  if (!referenceBackendType) verifyEntries(entries);
  return entries;
};
