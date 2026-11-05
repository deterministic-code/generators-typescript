import type { ParsedSettings } from "../../sdk/read-settings.ts";
import { toCase } from "../../sdk/case.ts";
import { viewGenerator } from "../../sdk/codegen-context.ts";
import { TypescriptImports } from "./typescript-imports.ts";
import {
  datetimeMergeGenerator,
  validatorOptionsFromSettings,
} from "../../sdk/codegen/lib/generate-settings-options.ts";
import { datasourceSettingsFor } from "../../sdk/codegen/lib/ts-datasource-settings.ts";
import type {
  ShapedView,
  UnionView,
  View,
  ViewField,
} from "../../sdk/codegen/lib/generate-view-shared.ts";

export const DEFAULT_GENERATE_OPTIONS = {
  schemaVersion: "1.0",
  datasourceImportPath: "../../datasource/validators",
  withTypeAnnotation: true,
  createIndex: true,
};

/** A shaped-view field carrying the size constraints the zod tighteners read (`minSize`/`size`); every other field property comes from `ViewField`. */
interface ValidatorField extends ViewField {
  minSize?: number;
  size?: number;
}

interface TsValidatorOpts {
  schemaVersion: string;
  datasourceImportPath: string;
  withTypeAnnotation: boolean;
  createIndex: boolean;
  datetime: string;
  idType?: string;
}

interface ImportRef {
  entity: string;
  artifact: string;
}

interface TsValidatorImports {
  crossArtifact(from: ImportRef, to: ImportRef): string;
}

interface TsValidatorCtx {
  names: {
    className(n: string): string;
    fileBase(n: string, a: string): string;
  };
  fields: { ident(n: string): string };
  opts: TsValidatorOpts;
  imports: TsValidatorImports;
  layout: { filePath(n: string, a: string): string };
  byFeature: boolean;
}

type ImportBucket = { generatePath: string; tokens: Set<string> };
type ImportMap = Map<string, ImportBucket>;

function viewSchemaIdent(name: string): string {
  return `${toCase(name, "Camel")}Schema`; // lint-generator-casing-allow: toCase
}

function datasourceSchemaIdent(name: string): string {
  return `datasource${toCase(name, "Pascal")}Schema`; // lint-generator-casing-allow: toCase
}

function crudTrioIdents(name: string) {
  const pascal = toCase(name, "Pascal"); // lint-generator-casing-allow: toCase
  return {
    create: `create${pascal}Schema`,
    update: `update${pascal}Schema`,
    patch: `patch${pascal}Schema`,
  };
}

function tightenStringPrimitive(field: ValidatorField): string {
  let expr = "z.string().trim()";
  const min = field.minSize;
  const max = field.size;
  if (Number.isInteger(min) && min! >= 0) expr = `${expr}.min(${min})`;
  if (Number.isInteger(max) && max! >= 0) expr = `${expr}.max(${max})`;
  return expr;
}

function tightenNumberPrimitive(field: ValidatorField): string {
  let expr = "z.number().int()";
  const fname = field.name;
  const isIdLike =
    fname === "id" || (typeof fname === "string" && fname.endsWith("_id"));
  if (isIdLike) expr = `${expr}.nonnegative()`;
  const min = field.minSize;
  const max = field.size;
  if (Number.isInteger(min)) expr = `${expr}.min(${min})`;
  if (Number.isInteger(max)) expr = `${expr}.max(${max})`;
  return expr;
}

function tightenPrimitive(
  base: string,
  field: ValidatorField,
  opts: TsValidatorOpts,
): string {
  if (base === "datetime") {
    return opts.datetime === "native" ? "z.date()" : "z.string().trim()";
  }
  if (base === "string") return tightenStringPrimitive(field);
  if (base === "number") return tightenNumberPrimitive(field);
  return `z.${base}()`;
}

function zodForField(field: ValidatorField, ctx: TsValidatorCtx): string {
  const { parsed } = field;
  let expr: string;
  switch (parsed.kind) {
    case "primitive":
      expr = tightenPrimitive(parsed.base, field, ctx.opts);
      break;
    case "datasource":
      expr = `z.lazy(() => ${datasourceSchemaIdent(parsed.base)})`;
      break;
    case "view":
      expr = `z.lazy(() => ${viewSchemaIdent(parsed.base)})`;
      break;
    default:
      throw new Error(`Unknown field kind: ${parsed.kind}`);
  }
  if (parsed.isArray) expr = `z.array(${expr})`;
  if (field.isNullable) expr = `${expr}.nullable()`;
  return `  ${ctx.fields.ident(field.name)}: ${expr},`;
}

function buildImports(view: View, ctx: TsValidatorCtx): ImportMap {
  const { names, opts, imports } = ctx;
  const from: ImportRef = { entity: view.name, artifact: "view-validator" };
  const byPath: ImportMap = new Map();
  const add = (sortKey: string, generatePath: string, token: string) => {
    if (!byPath.has(sortKey))
      byPath.set(sortKey, { generatePath, tokens: new Set() });
    byPath.get(sortKey)!.tokens.add(token);
  };

  const datasourceSeen = new Set<string>();
  const addDatasource = (baseName: string) => {
    if (datasourceSeen.has(baseName)) return;
    datasourceSeen.add(baseName);
    const localAlias = datasourceSchemaIdent(baseName);
    const imported = viewSchemaIdent(baseName);
    const flatPath = `${opts.datasourceImportPath}/${names.fileBase(baseName, "datasource-validator")}`;
    const generatePath = ctx.byFeature
      ? imports.crossArtifact(from, {
          entity: baseName,
          artifact: "datasource-validator",
        })
      : flatPath;
    add(flatPath, generatePath, `${imported} as ${localAlias}`);
  };

  const viewSeen = new Set<string>();
  const addView = (baseName: string) => {
    if (baseName === view.name || viewSeen.has(baseName)) return;
    viewSeen.add(baseName);
    const flatPath = `./${names.fileBase(baseName, "view-validator")}`;
    const generatePath = ctx.byFeature
      ? imports.crossArtifact(from, {
          entity: baseName,
          artifact: "view-validator",
        })
      : flatPath;
    add(flatPath, generatePath, viewSchemaIdent(baseName));
  };

  if (view.kind === "shaped") {
    if (view.inherits) addDatasource(view.inherits);
    for (const f of view.fields) {
      if (f.parsed.kind === "datasource") addDatasource(f.parsed.base);
      else if (f.parsed.kind === "view") addView(f.parsed.base);
    }
  } else if (view.kind === "union") {
    for (const m of view.members) addView(m);
  }
  return byPath;
}

function renderImports(imports: ImportMap): string {
  if (imports.size === 0) return "";
  const lines: string[] = [];
  const sortKeys = [...imports.keys()].sort();
  for (const sortKey of sortKeys) {
    const { generatePath, tokens } = imports.get(sortKey)!;
    const toks = [...tokens].sort().join(", ");
    lines.push(`import { ${toks} } from "${generatePath}";`);
  }
  return lines.join("\n");
}

function inheritedUpdateExpr(view: ShapedView, withUuid: boolean): string {
  const updateBase = datasourceSchemaIdent(view.inherits!);
  const baseOmits = withUuid
    ? ['"id"', '"uuid"', '"created"', '"updated"']
    : ['"id"', '"created"', '"updated"'];
  const enrichmentOmits = view.enrichments.map((e) =>
    JSON.stringify(e.fkColumn),
  );
  const omitObj = [...baseOmits, ...enrichmentOmits]
    .map((k) => `${k}: true`)
    .join(", ");
  let expr = `${updateBase}.omit({ ${omitObj} })`;
  if (view.enrichments.length > 0) {
    const extLines = view.enrichments
      .map((e) => `  ${JSON.stringify(e.newField)}: z.string().trim(),`)
      .join("\n");
    expr = `${expr}.extend({\n${extLines}\n})`;
  }
  return expr;
}

function resolveViewOmits(view: ShapedView, withUuid: boolean): string[] {
  return (view.omit ?? []).filter((k) => withUuid || k !== "uuid");
}

function shapedBaseSchema(
  view: ShapedView,
  ctx: TsValidatorCtx,
  withUuid: boolean,
): string {
  const schemaName = viewSchemaIdent(view.name);
  const hasFields = view.fields.length > 0;
  const fieldLines = view.fields.map((f) => zodForField(f, ctx)).join("\n");
  if (!view.inherits) {
    const objectLiteral = hasFields
      ? `z.object({\n${fieldLines}\n})`
      : "z.object({})";
    return `export const ${schemaName} = ${objectLiteral};`;
  }
  const viewOmits = resolveViewOmits(view, withUuid);
  const allOmits = [...view.enrichments.map((e) => e.fkColumn), ...viewOmits];
  let base = datasourceSchemaIdent(view.inherits);
  if (allOmits.length > 0) {
    const omitObj = allOmits
      .map((k) => `${JSON.stringify(k)}: true`)
      .join(", ");
    base = `${base}.omit({ ${omitObj} })`;
  }
  if (viewOmits.length > 0 && !viewOmits.includes("id")) {
    base = `${base}.partial({ id: true })`;
  }
  return hasFields
    ? `export const ${schemaName} = ${base}.extend({\n${fieldLines}\n});`
    : `export const ${schemaName} = ${base};`;
}

function crudTrioDecls(
  view: ShapedView,
  baseSchema: string,
  withUuid: boolean,
): string {
  const trio = crudTrioIdents(view.name);
  if (view.inherits) {
    const updateDecl = `export const ${trio.update} = ${inheritedUpdateExpr(view, withUuid)};`;
    const createDecl = `export const ${trio.create} = ${trio.update};`;
    const patchDecl = `export const ${trio.patch} = ${trio.update}.partial();`;
    return `${baseSchema}\n${updateDecl}\n${createDecl}\n${patchDecl}`;
  }
  const schemaName = viewSchemaIdent(view.name);
  const createDecl = `export const ${trio.create} = ${schemaName};`;
  const updateDecl = `export const ${trio.update} = ${schemaName};`;
  const patchDecl = `export const ${trio.patch} = ${schemaName}.partial();`;
  return `${baseSchema}\n${createDecl}\n${updateDecl}\n${patchDecl}`;
}

function generateShapedSchema(view: ShapedView, ctx: TsValidatorCtx): string {
  const withUuid = datasourceSettingsFor(ctx.opts).withUuidColumn;
  const baseSchema = shapedBaseSchema(view, ctx, withUuid);
  if (resolveViewOmits(view, withUuid).length > 0) return baseSchema;
  return crudTrioDecls(view, baseSchema, withUuid);
}

function generateUnionSchema(view: UnionView): string {
  const schemaName = viewSchemaIdent(view.name);
  const members = view.members
    .map((m) => `z.lazy(() => ${viewSchemaIdent(m)})`)
    .join(",\n  ");
  return `export const ${schemaName} = z.union([\n  ${members},\n]);`;
}

function typeAnnotationLine(view: View, ctx: TsValidatorCtx): string {
  if (!ctx.opts.withTypeAnnotation) return "";
  const cls = ctx.names.className(view.name);
  const schemaName = viewSchemaIdent(view.name);
  return `export type ${cls}Validated = z.infer<typeof ${schemaName}>;`;
}

function renderView(view: View, ctx: TsValidatorCtx) {
  const generatePath = ctx.layout.filePath(view.name, "view-validator");
  const extraImports = renderImports(buildImports(view, ctx));
  const zodImport = `import { z } from "zod";`;
  const importBlock = extraImports
    ? `${zodImport}\n${extraImports}`
    : zodImport;
  const header = `// schema-version: ${ctx.opts.schemaVersion}\n${importBlock}\n\n`;

  const schemaBody =
    view.kind === "union" ? generateUnionSchema(view) : generateShapedSchema(view, ctx);
  const typeLine = typeAnnotationLine(view, ctx);
  const trailing = typeLine ? `\n\n${typeLine}\n` : "\n";

  return { path: generatePath, content: `${header}${schemaBody}${trailing}` };
}

function indexLine(v: View, ctx: TsValidatorCtx): string | null {
  const omitKeys = v.kind === "shaped" ? v.omit : [];
  if ((omitKeys ?? []).length > 0) return null;
  const file = ctx.names.fileBase(v.name, "view-validator");
  const schemaName = viewSchemaIdent(v.name);
  const lines: string[] = [];
  if (v.kind === "union") {
    lines.push(`export { ${schemaName} } from "./${file}";`);
  } else {
    const trio = crudTrioIdents(v.name);
    const schemas = [schemaName, trio.create, trio.update, trio.patch].join(
      ", ",
    );
    lines.push(`export { ${schemas} } from "./${file}";`);
  }
  if (ctx.opts.withTypeAnnotation) {
    const typeName = `${ctx.names.className(v.name)}Validated`;
    lines.push(`export type { ${typeName} } from "./${file}";`);
  }
  return lines.join("\n");
}

const baseCreateGenerator = viewGenerator(renderView, indexLine);

export const createGenerator = () => {
  const base = datetimeMergeGenerator(
    baseCreateGenerator,
    TypescriptImports,
    DEFAULT_GENERATE_OPTIONS,
  );
  return {
    generate: (config: { settings: ParsedSettings }) =>
      base.generate({
        ...validatorOptionsFromSettings(config.settings),
        ...config,
      }),
  };
};
