import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { ROUTES_YAML } from "@deterministic-code/generators-common/spec-types";
import { createCasing } from "./common/default-casing.ts";
import { e2eTmpl } from "./resources/routes-e2e.ts";

export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(ROUTES_YAML);
  const casing = createCasing(ctx.settings);
  return [
    content(
      "__tests__/app.integration.test.ts",
      fill(e2eTmpl, {
        appFnName: casing.appFnName(),
        appFileBase: casing.fileBase("app"),
      }),
    ),
  ];
};
