import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { verifyEntries } from "@deterministic-code/generators-common/reference-verifier";
import { generateShapedTypes } from "./emit-shaped-types.ts";

/** Self-checks references; keeps attributes for host `finalizeEntries` before write. */
export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  const entries = await generateShapedTypes(ctx, { kind: "datasource" });
  verifyEntries(entries);
  return entries;
};
