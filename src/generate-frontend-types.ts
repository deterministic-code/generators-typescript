import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { verifyEntries } from "@deterministic-code/generators-common/reference-verifier";
import { createCasing } from "./common/default-casing.ts";
import { Emit } from "./emit.ts";
import { generateViewTypes } from "./emit-shaped-types.ts";
import { referencesBackend } from "./inline-inherited.ts";

const layered = (settings: Record<string, string>, path: string): string => {
  const casing = createCasing(settings);
  return path.split("/").map((segment) => casing.convertDirectories(segment)).join("/");
};

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
      ? layered(ctx.settings, "types/generated/datasource")
      : views,
  });
  if (!referenceBackendType) verifyEntries(entries);
  return entries;
};
