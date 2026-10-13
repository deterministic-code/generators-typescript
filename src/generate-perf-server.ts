import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, patch, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { TYPES_YAML } from "@deterministic-code/generators-common/spec-types";
import { createCasing } from "./common/default-casing.ts";
import { serverTmpl, vitestPerfTmpl } from "./resources/perf-server.ts";

export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  if (!(await ctx.reader.exists(TYPES_YAML))) {
    throw new Error("generate-perf-server: types.yaml is required");
  }
  await ctx.reader.read(TYPES_YAML);
  const casing = createCasing(ctx.settings);
  return [
    content(
      "perf-server.ts",
      fill(serverTmpl, {
        appFnName: casing.appFnName(),
        appFileBase: casing.fileBase("app"),
      }),
    ),
    content("vitest.perf.config.ts", vitestPerfTmpl),
    patch(
      "package.json",
      JSON.stringify({
        scripts: { "test:perf": "vitest run --config vitest.perf.config.ts" },
      }),
    ),
  ];
};
