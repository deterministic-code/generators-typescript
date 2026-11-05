import { toCase } from "../../sdk/case.ts";
import {
  entryOf,
  isFiniteInt,
} from "../../sdk/generator-shared.ts";
import { datasourceValidatorGenerator } from "../../sdk/codegen-context.ts";
import type { CodegenNames } from "../../sdk/codegen-naming.ts";
import type { CodegenFieldNames } from "../../sdk/field-names.ts";
import type { CodegenLayout } from "../../sdk/codegen-layout.ts";
import { validatorOptionsFromSettings } from "../../sdk/codegen/lib/generate-settings-options.ts";
import { datasourceSettingsFor } from "../../sdk/codegen/lib/ts-datasource-settings.ts";
import { loadFieldTypeCatalog } from "../../sdk/lib/field-type-catalog.ts";
import { fieldConverterFor } from "../../sdk/lib/field-converter.ts";
import {
  parseDefaultToken,
  GENERATIVE_TOKENS,
} from "../../sdk/lib/default-token.ts";
import {
  STANDARD_COLUMNS,
  type DatasourceValidatorGenerateConfig,
  type GeneratedFile,
  type ValidatorFieldDef,
} from "../../sdk/codegen/lib/datasource-validator-generate-types.ts";

interface TsFieldConverter {
  defaultLiteral(type: string, value: unknown): string;
}

interface TsFieldDef extends ValidatorFieldDef {
  default_value?: unknown;
}

interface TsTableDef {
  fields: Array<Record<string, unknown>>;
}

interface TsGenerateOptions {
  schemaVersion: string;
  withTypeAnnotation: boolean;
  createIndex?: boolean;
  datetime?: string;
  idType?: string;
}

interface TsCtx {
  opts: TsGenerateOptions;
  names: CodegenNames;
  fields: CodegenFieldNames;
  layout: CodegenLayout;
}

const CATALOG = await loadFieldTypeCatalog();
const TS_CONVERTERS = new Map<string | undefined, TsFieldConverter>();

/** The TypeScript field converter for a datetime representation, cached — defaults render through it so symbolic tokens become expressions, not string literals. */
function tsConverter(datetimeRepr: string | undefined): TsFieldConverter {
  if (!TS_CONVERTERS.has(datetimeRepr)) {
    TS_CONVERTERS.set(
      datetimeRepr,
      fieldConverterFor({
        targetKind: "language",
        target: "typescript",
        catalog: CATALOG,
        datetimeRepr,
      }) as TsFieldConverter,
    );
  }
  return TS_CONVERTERS.get(datetimeRepr)!;
}

/** The argument for a Zod `.default(…)` — a generative token (Now/UtcNow/NewId) becomes a thunk so each parse gets a fresh value; a static default is the literal itself. */
function zodDefaultArg(
  fdef: TsFieldDef,
  datetimeRepr: string | undefined,
): string {
  const value = fdef.default_value;
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  const { token } = parseDefaultToken(fdef.type, value);
  const literal = tsConverter(datetimeRepr).defaultLiteral(fdef.type, value);
  return GENERATIVE_TOKENS.has(token) ? `() => ${literal}` : literal;
}

export const DEFAULT_GENERATE_OPTIONS: TsGenerateOptions = {
  schemaVersion: "1.0",
  withTypeAnnotation: true,
  createIndex: true,
};

const BASE_ZOD: Record<string, string> = {
  string: "z.string()",
  character: "z.string()",
  decimal: "z.string()",
  number: "z.number()",
  integer: "z.number()",
  smallinteger: "z.number()",
  float: "z.number()",
  reference: "z.number()",
  biginteger: "z.number()",
  boolean: "z.boolean()",
  binary: "z.string().base64()",
  uuid: "z.string().uuid()",
};

function schemaIdent(name: string): string {
  return `${toCase(name, "Camel")}Schema`; // lint-generator-casing-allow: toCase
}

function baseZodFor(type: string, datetime: string | undefined): string {
  if (type === "datetime") {
    return datetime === "native" ? "z.date()" : "z.string()";
  }
  const expr = BASE_ZOD[type];
  if (!expr) throw new Error(`Unknown datasource field type: ${type}`);
  return expr;
}

function tightenString(base: string, fdef: ValidatorFieldDef): string {
  let e = `${base}.trim()`;
  if (isFiniteInt(fdef.min_size) && fdef.min_size! >= 0) {
    e = `${e}.min(${fdef.min_size})`;
  }
  if (isFiniteInt(fdef.size) && fdef.size! >= 0) {
    e = `${e}.max(${fdef.size})`;
  }
  return e;
}

function tightenInteger(
  base: string,
  fdef: ValidatorFieldDef,
  { isFk, isIdLike }: { isFk: boolean; isIdLike: boolean },
): string {
  let e = `${base}.int()`;
  if (isFk || isIdLike) e = `${e}.nonnegative()`;
  if (isFiniteInt(fdef.min_size)) e = `${e}.min(${fdef.min_size})`;
  if (isFiniteInt(fdef.size)) e = `${e}.max(${fdef.size})`;
  return e;
}

function tightenExpr(
  fieldName: string,
  fdef: ValidatorFieldDef,
  datetime: string | undefined,
): string {
  const base = baseZodFor(fdef.type, datetime);
  const isFk =
    typeof fdef.references === "string" && fdef.references.length > 0;
  const isIdLike = fieldName === "id" || fieldName.endsWith("_id");

  switch (fdef.type) {
    case "string":
    case "character":
      return tightenString(base, fdef);
    case "datetime":
      return datetime === "native" ? base : `${base}.trim()`;
    case "number":
    case "integer":
    case "biginteger":
    case "smallinteger":
    case "reference":
      return tightenInteger(base, fdef, { isFk, isIdLike });
    case "float":
      return isFiniteInt(fdef.min_size)
        ? `${base}.min(${fdef.min_size})`
        : base;
    default:
      return base;
  }
}

function zodForField(fieldName: string, fdef: TsFieldDef, ctx: TsCtx): string {
  const ds = datasourceSettingsFor(ctx.opts);
  let expr = ds.referenceIsUuid(fdef.references)
    ? ds.zodIdType()
    : tightenExpr(fieldName, fdef, ctx.opts.datetime);
  if (fdef.is_nullable === true) expr = `${expr}.nullable()`;
  if (Object.prototype.hasOwnProperty.call(fdef, "default_value")) {
    expr = `${expr}.default(${zodDefaultArg(fdef, ctx.opts.datetime)})`;
  }
  return `  ${ctx.fields.ident(fieldName)}: ${expr},`;
}

function standardLines(ctx: TsCtx): string[] {
  const ds = datasourceSettingsFor(ctx.opts);
  return STANDARD_COLUMNS.filter(
    (c) => ds.withUuidColumn || c.name !== "uuid",
  ).map((col) => {
    const expr =
      col.name === "id"
        ? ds.zodIdType()
        : tightenExpr(col.name, { type: col.type }, ctx.opts.datetime);
    return `  ${ctx.fields.ident(col.name)}: ${expr},`;
  });
}

function renderTable(
  tableEntry: Record<string, unknown>,
  ctx: TsCtx,
): GeneratedFile {
  const { names } = ctx;
  const [tableName, tableDefRaw] = entryOf(tableEntry);
  const fields = (tableDefRaw as TsTableDef).fields;

  const userFieldNames = new Set(
    fields.map((f) => ctx.fields.name(entryOf(f)[0])),
  );
  const keyOf = (line: string): string => {
    const m = line.match(/^\s*("?[A-Za-z_$][A-Za-z0-9_$]*"?)\s*:/);
    return m![1].replace(/^"|"$/g, "");
  };
  const fieldLines = [
    ...standardLines(ctx).filter((line) => !userFieldNames.has(keyOf(line))),
    ...fields.map((f) => {
      const [fname, fdef] = entryOf(f);
      return zodForField(fname, fdef as TsFieldDef, ctx);
    }),
  ].join("\n");

  const schemaName = schemaIdent(tableName);
  const header = `// schema-version: ${ctx.opts.schemaVersion}\nimport { z } from "zod";\n\n`;
  const schemaDecl = `export const ${schemaName} = z.object({\n${fieldLines}\n});`;
  const typeLine = ctx.opts.withTypeAnnotation
    ? `\n\nexport type ${names.className(tableName)}Validated = z.infer<typeof ${schemaName}>;\n`
    : "\n";

  return {
    path: ctx.layout.filePath(tableName, "datasource-validator"),
    content: `${header}${schemaDecl}${typeLine}`,
  };
}

function indexLine(entry: Record<string, unknown>, ctx: TsCtx): string {
  const [tableName] = entryOf(entry);
  const file = ctx.names.fileBase(tableName, "datasource-validator");
  const schemaName = schemaIdent(tableName);
  const lines = [`export { ${schemaName} } from "./${file}";`];
  if (ctx.opts.withTypeAnnotation) {
    lines.push(
      `export type { ${ctx.names.className(tableName)}Validated } from "./${file}";`,
    );
  }
  return lines.join("\n");
}

const baseCreateGenerator = datasourceValidatorGenerator(renderTable, indexLine);

/** Generator owns its options: apply this dialect's DEFAULT_GENERATE_OPTIONS, then datasource overrides read from settings, then the dispatched config. */
export const createGenerator = () => {
  const base = baseCreateGenerator();
  return {
    generate: (config: DatasourceValidatorGenerateConfig) =>
      base.generate({
        ...DEFAULT_GENERATE_OPTIONS,
        ...validatorOptionsFromSettings(config.settings),
        ...config,
      }),
  };
};
