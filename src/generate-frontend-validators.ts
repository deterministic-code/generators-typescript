import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { Paths } from "@deterministic-code/generators-common/paths";
import { verifyEntries } from "@deterministic-code/generators-common/reference-verifier";
import { createCasing } from "./common/default-casing.ts";
import { Emit } from "./emit.ts";
import { generate as generateViewTypeValidators } from "./generate-view-type-validators.ts";
import { referencesBackend } from "./inline-inherited.ts";

const layered = (settings: Record<string, string>, path: string): string => {
  const casing = createCasing(settings);
  return path.split("/").map((segment) => casing.convertDirectories(segment)).join("/");
};

const paths = new Paths();
import {
  indexTmpl,
  schemaInheritTmpl,
  schemaStandaloneTmpl,
  schemaUnionTmpl,
  typeTmpl,
} from "./resources/frontend-validators.ts";

/** Self-checks when the lane is closed; backend-schema refs need host `finalizeEntries`. */
export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  const referenceBackendType = referencesBackend(ctx.settings);
  const validators = new Emit(ctx.settings).imports.frontend(
    "src/validators",
  );
  const entries = await generateViewTypeValidators(ctx, {
    referenceBackendType,
    templates: {
      typeTmpl,
      indexTmpl,
      schemaUnionTmpl,
      schemaStandaloneTmpl,
      schemaInheritTmpl,
    },
    basePath: validators,
    datasourceBasePath: referenceBackendType
      ? layered(ctx.settings, `${paths.typesDir("datasource")}/validators`)
      : validators,
  });
  if (!referenceBackendType) verifyEntries(entries);
  return entries;
};
