import type { ReferenceAttributes } from "@deterministic-code/generators-common/generate-entry";
import {
  fromSettings,
  type ISettings,
} from "@deterministic-code/generators-common/settings";
import { createCasing, type PackCasing } from "./common/default-casing.ts";
import {
  createImportGenerator,
  type TypeScriptImportGenerator,
} from "./import-generator.ts";

const joinList = (
  value: string | readonly string[] | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  const parts = (typeof value === "string" ? [value] : [...value])
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length === 0 ? undefined : parts.join(", ");
};

/** Verifier bag: `module` / `imports` are Rel keys; `exports` / `uses` are identifiers. */
export const bag = (attrs: {
  module: string;
  exports?: string | readonly string[];
  imports?: string | readonly string[];
  uses?: string | readonly string[];
}): ReferenceAttributes => {
  const out: ReferenceAttributes = { module: attrs.module };
  const exports = joinList(attrs.exports);
  const imports = joinList(attrs.imports);
  const uses = joinList(attrs.uses);
  if (exports !== undefined) out.exports = exports;
  if (imports !== undefined) out.imports = imports;
  if (uses !== undefined) out.uses = uses;
  return out;
};

/** Map `../….ts` emit paths to project-relative Rel keys (`services/….ts`). */
export const customRelKey = (
  emitPath: string,
  layer: "services" | "routes",
): string =>
  emitPath.startsWith("../") ? `${layer}/${emitPath.slice(3)}` : emitPath;

/** Settings plus pack import generators created once; lanes use `this.imports`. */
export class Emit {
  readonly settings: ISettings;
  readonly casing: PackCasing;
  readonly imports: TypeScriptImportGenerator;
  readonly datasourceImports: TypeScriptImportGenerator;

  constructor(
    raw: Record<string, string>,
    basePath = ".",
    datasourceBasePath?: string,
  ) {
    this.settings = fromSettings(raw);
    this.casing = createCasing(raw);
    this.imports = createImportGenerator(basePath, raw);
    this.datasourceImports = createImportGenerator(
      datasourceBasePath ?? ".",
      raw,
    );
  }
}
