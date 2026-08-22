import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  DeterministicParser,
  type IDeterministic,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import { fromSettings } from "@deterministic-code/generators-common/settings";
import { ROUTES_YAML } from "@deterministic-code/deterministic-specifications-typescript/parser";
import { libraryImportSpecifier } from "./library-import.ts";
import { e2eTmpl } from "./resources/routes-e2e.ts";

const generateFrom = (
  deterministic: IDeterministic,
  settings: Record<string, string>,
): GenerateEntry[] => [
  content(
    "__tests__/app.integration.test.ts",
    fill(e2eTmpl, {
      detRoot: libraryImportSpecifier(
        "",
        fromSettings(settings).libraryReferenceMode,
        "__tests__/app.integration.test.ts",
      ),
      entitiesJson: JSON.stringify(
        deterministic.routes.candidates.map((c) => c.name),
      ),
    }),
  ),
];

export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(ROUTES_YAML);
  return generateFrom(
    await DeterministicParser(ctx.reader).parse(ctx.settings),
    ctx.settings,
  );
};
