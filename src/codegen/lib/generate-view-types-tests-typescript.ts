import { STEPS } from "../../sdk/import-paths.ts";
import { createGenerator } from "./generate-view-tests-typescript.ts";
import { makeViewGenerate } from "../../sdk/codegen/lib/view-generate-config.ts";

export const generate = makeViewGenerate(
  createGenerator,
  STEPS.VIEW_TYPES_TESTS,
  "typescript",
);
