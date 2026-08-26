import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  DeterministicParser,
  type CustomServiceEntry,
  type IDeterministic,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import { fromSettings } from "@deterministic-code/generators-common/settings";
import { ROUTES_YAML } from "@deterministic-code/generators-common/spec-types";
import { createImportGenerator } from "./import-generator.ts";
import { libraryImportSpecifier } from "./library-import.ts";
import { e2eTmpl } from "./resources/routes-e2e.ts";

/** Same remap as generate-services: authored module → by-feature emit path. */
const customModulePathsOf = (
  customs: CustomServiceEntry[],
  settings: Record<string, string>,
): Record<string, string> => {
  const imports = createImportGenerator(".", settings);
  const paths: Record<string, string> = {};
  for (const entry of customs) {
    if (entry.module === undefined || entry.module === "") continue;
    const laid = imports.serviceCustom(entry.name, entry.module).replace(/\.ts$/, "");
    if (!laid.startsWith("features/")) continue;
    const mapped = `./${laid}`;
    if (mapped !== entry.module) paths[entry.module] = mapped;
  }
  return paths;
};

const generateFrom = (
  deterministic: IDeterministic,
  settings: Record<string, string>,
): GenerateEntry[] => {
  const customModulePaths = customModulePathsOf(
    deterministic.services.customs,
    settings,
  );
  const hasCustomModulePaths = Object.keys(customModulePaths).length > 0;
  return [
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
        hasCustomModulePaths,
        customModulePathsJson: JSON.stringify(customModulePaths, null, 2),
      }),
    ),
  ];
};

export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(ROUTES_YAML);
  return generateFrom(
    await DeterministicParser(ctx.reader).parse(ctx.settings),
    ctx.settings,
  );
};
