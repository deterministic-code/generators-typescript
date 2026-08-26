import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generateViewTypes } from "./emit-shaped-types.ts";

/** Returns attributed entries. Cross-lane datasource imports need host `finalizeEntries`. */
export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => generateViewTypes(ctx);
