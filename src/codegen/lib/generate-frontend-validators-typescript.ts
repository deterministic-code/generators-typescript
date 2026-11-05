import { join } from "node:path";
import { CodegenFieldNames } from "../../sdk/field-names.ts";
import { namesForSettings } from "../../sdk/codegen/lib/ts-codegen-naming.ts";
import { datetimeOptionFromSettings } from "../../sdk/codegen/lib/generate-settings-options.ts";
import { schemaSymbol, validatedSymbol } from "./zod-schema-names.ts";
import { refName, validatorObjectEntries } from "./frontend-bindings-routes.ts";
import { PATCH } from "../../sdk/codegen/lib/generate-result.ts";
import type { GenerateEntry } from "../../sdk/codegen/lib/generate-result.ts";
import type { GenerateArgs, SchemaProp } from "./frontend-generate-types.ts";
import type { CodegenNames } from "../../sdk/codegen-naming.ts";

const ZOD_VERSION = "^3.23.8";

interface ValidatorBase {
  names: CodegenNames;
  fields: CodegenFieldNames;
  datetime: string;
}

interface ValidatorCtx extends ValidatorBase {
  componentNames: Set<string>;
  refs: Set<string>;
  requiredSet?: Set<string> | null;
}

function registerRef(name: string, ctx: ValidatorCtx): void {
  if (!ctx.componentNames.has(name)) {
    throw new Error(`frontend_validators: $ref to unknown component "${name}"`);
  }
  ctx.refs.add(name);
}

function isIdLike(prop: SchemaProp, keyHint: string | null): boolean {
  return Boolean(
    prop["x-references"] ||
    keyHint === "id" ||
    (keyHint && keyHint.endsWith("_id")),
  );
}

function scalarZod(
  prop: SchemaProp,
  ctx: ValidatorCtx,
  keyHint: string | null,
): string {
  switch (prop.type) {
    case "integer":
      return isIdLike(prop, keyHint)
        ? "z.number().int().nonnegative()"
        : "z.number().int()";
    case "number":
      // a foreign-key reference surfaces as {type:number, x-references}; tighten it to a non-negative int like the backend validator, leaving genuine decimals as z.number().
      return prop["x-references"]
        ? "z.number().int().nonnegative()"
        : "z.number()";
    case "boolean":
      return "z.boolean()";
    case "string":
      if (prop.format === "uuid") return "z.string().uuid()";
      // wire JSON carries a datetime as a string; z.coerce.date() accepts that string and yields a Date so the inferred type matches frontend_types' native Date, while the string mode keeps it a string.
      if (prop.format === "date-time") {
        return ctx.datetime === "native" ? "z.coerce.date()" : "z.string()";
      }
      return Number.isFinite(prop.maxLength)
        ? `z.string().max(${prop.maxLength})`
        : "z.string()";
    default:
      throw new Error(
        `frontend_validators: unmapped scalar ${JSON.stringify(prop)}`,
      );
  }
}

function baseZod(
  prop: SchemaProp,
  ctx: ValidatorCtx,
  keyHint: string | null,
): string {
  if (prop.$ref) {
    const name = refName(prop.$ref);
    registerRef(name, ctx);
    return `z.lazy(() => ${schemaSymbol(name, ctx.names)})`;
  }
  if (Array.isArray(prop.oneOf)) {
    return `z.union([${prop.oneOf.map((m) => baseZod(m, ctx, null)).join(", ")}])`;
  }
  if (prop.type === "array") {
    return `z.array(${baseZod(prop.items!, ctx, null)})`;
  }
  if (Array.isArray(prop.enum) && prop.type === "string") {
    return `z.enum([${prop.enum.map((v) => JSON.stringify(v)).join(", ")}])`;
  }
  return scalarZod(prop, ctx, keyHint);
}

function fieldZod(key: string, prop: SchemaProp, ctx: ValidatorCtx): string {
  let expr = baseZod(prop, ctx, key);
  if (prop.nullable === true) expr = `${expr}.nullable()`;
  if (ctx.requiredSet && !ctx.requiredSet.has(key)) {
    expr = `${expr}.optional()`;
  }
  return `  ${ctx.fields.ident(key)}: ${expr},`;
}

function renderComponent(
  name: string,
  schema: SchemaProp,
  ctx: ValidatorCtx,
): string {
  const symbol = schemaSymbol(name, ctx.names);
  if (Array.isArray(schema.oneOf)) {
    const members = schema.oneOf.map((m) => baseZod(m, ctx, null));
    const body =
      members.length === 1 ? members[0] : `z.union([${members.join(", ")}])`;
    return `export const ${symbol} = ${body};`;
  }
  const props = schema.properties ?? {};
  const fieldCtx: ValidatorCtx = {
    ...ctx,
    requiredSet: Array.isArray(schema.required)
      ? new Set(schema.required)
      : null,
  };
  const lines = Object.keys(props).map((key) =>
    fieldZod(key, props[key], fieldCtx),
  );
  const body = lines.length ? `\n${lines.join("\n")}\n` : "";
  return `export const ${symbol} = z.object({${body}});`;
}

function renderObjectValidators(
  closure: Set<string>,
  components: Record<string, SchemaProp>,
  base: ValidatorBase,
): string {
  const ctx: ValidatorCtx = {
    ...base,
    componentNames: closure,
    refs: new Set<string>(),
  };
  const names = [...closure].sort((a, b) =>
    schemaSymbol(a, base.names).localeCompare(schemaSymbol(b, base.names)),
  );
  const bodies = names.map((name) =>
    renderComponent(name, components[name], ctx),
  );
  const aliases = names.map(
    (name) =>
      `export type ${validatedSymbol(name, base.names)} = z.infer<typeof ${schemaSymbol(name, base.names)}>;`,
  );
  return `import { z } from "zod";\n\n${bodies.join("\n\n")}\n\n${aliases.join("\n")}\n`;
}

/** The generated validators.ts files `import { z } from "zod"`, so the frontend needs zod at runtime — add it (add-if-absent, deep-merged) rather than leaving a dangling import the generated app can't resolve. */
function zodDependencyPatch() {
  return {
    kind: PATCH,
    filename: join("frontend", "package.json"),
    content: JSON.stringify({ dependencies: { zod: ZOD_VERSION } }),
  };
}

/** Generate a self-contained zod validators file per object, placed by layout mode via `CodegenLayout.frontendValidatorFile` (flat `validators/<object>.ts`, by-feature `features/<object>/validators.ts`) — driven by the same `frontend_bindings.yaml` + route projection as `client_bindings`, so validators track the clients. Each file holds the zod schemas for the read + create/update/eager types that object's routes send/receive (transitive `$ref` closure); `client_bindings` imports them through the layout's `frontendRelImport`. Always generates when the step runs; `settings.frontend.generate_validators` gates only whether the frontend `--all` sweep includes this step (see generate.mjs runAll). `$ref` becomes `z.lazy(() => XSchema)` so circular refs survive ESM module init; datetime honors the setting (native → `z.coerce.date()`). */
export async function generate({ inputs, settings }: GenerateArgs) {
  const names = namesForSettings(settings, "typescript");
  const fields = new CodegenFieldNames({ fieldFormat: names.fieldFormat });
  const base: ValidatorBase = {
    names,
    fields,
    datetime: datetimeOptionFromSettings(settings).datetime,
  };
  const entries: GenerateEntry[] = await validatorObjectEntries(
    { inputs, settings },
    { test: false },
    (closure: Set<string>, components: Record<string, SchemaProp>) =>
      renderObjectValidators(closure, components, base),
  );
  if (entries.length > 0) entries.push(zodDependencyPatch());
  return { entries };
}

export const entriesNative = true;

export const assembleAfterStep = true;
