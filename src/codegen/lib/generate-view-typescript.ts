import {
  DEFAULT_COMMENT_STYLE,
  renderDocComment,
} from "../../sdk/generate-doc-comment.ts";
import {
  buildViewGenerator,
  shapedViewDocLines,
  unionViewDocLines,
  type ShapedView,
  type UnionView,
  type View,
  type ViewField,
} from "../../sdk/codegen/lib/generate-view-shared.ts";
import { viewGenerator } from "../../sdk/codegen-context.ts";
import { TypescriptImports } from "./typescript-imports.ts";
import { datetimeOptionFromSettings } from "../../sdk/codegen/lib/generate-settings-options.ts";

export const DEFAULT_GENERATE_OPTIONS = {
  baseClass: null,
  schemaVersion: "1.0",
  createIndex: true,
  style: DEFAULT_COMMENT_STYLE,
};

interface ImportFrom {
  entity: string;
  artifact: string;
}

interface ImportEntry {
  original: string;
  alias: string | null;
  fromPath: string;
}

interface TsGenerateOpts {
  baseClass: string | null;
  schemaVersion: string;
  datetime: string;
  libraryReferenceMode: unknown;
  style: unknown;
}

interface TsImports {
  library(kind: string, mode: unknown, from: ImportFrom): string;
  crossArtifact(from: ImportFrom, to: ImportFrom): string;
  render(entries: ImportEntry[]): string;
}

interface TsCtx {
  names: {
    className(n: string): string;
    fileBase(n: string, a: string): string;
  };
  fields: { ident(n: string): string };
  opts: TsGenerateOpts;
  imports: TsImports;
  layout: { filePath(n: string, a: string): string };
}

interface ImportCollector {
  selfClass: string;
  from: ImportFrom;
  add(original: string, alias: string | null, fromPath: string): void;
  aliasIfCollides(cls: string): string | null;
  aliasByClass: Map<string, string>;
  crossPath(base: string, artifact: string): string;
}

function tsPrimitiveType(base: string, datetime: string): string {
  switch (base) {
    case "datetime":
      return datetime === "native" ? "Date" : "string";
    case "uuid":
      return "string";
    case "integer":
    case "smallinteger":
    case "biginteger":
    case "float":
    case "reference":
      return "number";
    case "binary":
      return "string";
    default:
      return base;
  }
}

function tsForField(
  field: ViewField,
  ctx: TsCtx,
  aliasByClass: Map<string, string> | undefined,
): string {
  const { names, fields, opts } = ctx;
  const { parsed } = field;
  let tsType: string;
  switch (parsed.kind) {
    case "primitive":
      tsType = tsPrimitiveType(parsed.base, opts.datetime);
      break;
    case "datasource":
    case "view": {
      const cls = names.className(parsed.base);
      tsType = aliasByClass?.get(cls) ?? cls;
      break;
    }
    default:
      throw new Error(`Unknown field kind: ${parsed.kind}`);
  }
  if (parsed.isArray) tsType = `${tsType}[]`;
  const nullable = field.isNullable ? " | null" : "";
  return `  ${fields.ident(field.name)}: ${tsType}${nullable};`;
}

/** `c` bundles the collector closures + selfClass/from/aliasByClass so the per-kind helpers stay under the statement limit; it is internal to collectImports, not a public option bag. */
function addShapedImports(view: ShapedView, ctx: TsCtx, c: ImportCollector) {
  const { names, opts, imports } = ctx;
  if (view.inherits) {
    const cls = names.className(view.inherits);
    c.add(
      cls,
      c.aliasIfCollides(cls),
      c.crossPath(view.inherits, "datasource-type"),
    );
  } else if (opts.baseClass) {
    const lib = imports.library("types", opts.libraryReferenceMode, c.from);
    c.add(opts.baseClass, null, lib);
  }
  for (const f of view.fields) {
    if (f.parsed.kind === "datasource") {
      const cls = names.className(f.parsed.base);
      c.add(
        cls,
        c.aliasByClass.get(cls) ?? c.aliasIfCollides(cls),
        c.crossPath(f.parsed.base, "datasource-type"),
      );
    } else if (f.parsed.kind === "view") {
      const cls = names.className(f.parsed.base);
      if (cls !== c.selfClass)
        c.add(cls, null, c.crossPath(f.parsed.base, "view-type"));
    }
  }
}

function addUnionImports(
  view: UnionView,
  names: TsCtx["names"],
  c: ImportCollector,
) {
  for (const m of view.members) {
    const cls = names.className(m);
    if (cls !== c.selfClass) c.add(cls, null, c.crossPath(m, "view-type"));
  }
}

function collectImports(view: View, ctx: TsCtx) {
  const { names, imports } = ctx;
  const selfClass = names.className(view.name);
  const from: ImportFrom = { entity: view.name, artifact: "view-type" };
  const entries: ImportEntry[] = [];
  const seen = new Set<string>();
  const aliasByClass = new Map<string, string>();
  const add = (original: string, alias: string | null, fromPath: string) => {
    const key = `${fromPath}::${original}::${alias ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ original, alias, fromPath });
  };
  const aliasIfCollides = (cls: string): string | null => {
    if (cls !== selfClass) return null;
    const aliased = `${cls}Base`;
    aliasByClass.set(cls, aliased);
    return aliased;
  };
  const crossPath = (base: string, artifact: string) =>
    imports.crossArtifact(from, { entity: base, artifact });
  const c: ImportCollector = {
    selfClass,
    from,
    add,
    aliasIfCollides,
    aliasByClass,
    crossPath,
  };
  if (view.kind === "shaped") addShapedImports(view, ctx, c);
  else if (view.kind === "union") addUnionImports(view, names, c);
  return { entries, aliasByClass };
}

function shapedExtendsClause(
  view: ShapedView,
  ctx: TsCtx,
  aliasByClass: Map<string, string>,
): string {
  const { names, opts } = ctx;
  const inheritCls = view.inherits ? names.className(view.inherits) : null;
  const extendsClass = view.inherits
    ? (aliasByClass.get(inheritCls!) ?? inheritCls)
    : opts.baseClass;
  if (!extendsClass) return "";
  const allOmitKeys = [
    ...view.enrichments.map((e) => e.fkColumn),
    ...view.omit,
  ];
  if (allOmitKeys.length > 0 && view.inherits) {
    const keys = allOmitKeys.map((k) => JSON.stringify(k)).join(" | ");
    return ` extends Omit<${extendsClass}, ${keys}>`;
  }
  return ` extends ${extendsClass}`;
}

function renderView(view: View, ctx: TsCtx) {
  const { names, opts } = ctx;
  const className = names.className(view.name);
  const generatePath = ctx.layout.filePath(view.name, "view-type");
  const { entries, aliasByClass } = collectImports(view, ctx);
  const importBlock = ctx.imports.render(entries);
  const header = `// schema-version: ${opts.schemaVersion}\n${importBlock}${importBlock ? "\n\n" : ""}`;

  if (view.kind === "union") {
    const union = view.members.map((m) => names.className(m)).join(" | ");
    const doc = renderDocComment({
      style: opts.style,
      summary: `View ${className}.`,
      lines: unionViewDocLines(view),
    });
    const content = `${header}${doc}export type ${className} = ${union};\n`;
    return { path: generatePath, content };
  }

  const extendsClause = shapedExtendsClause(view, ctx, aliasByClass);
  const body = view.fields
    .map((f) => tsForField(f, ctx, aliasByClass))
    .join("\n");
  const interfaceBody = body ? `\n${body}\n` : "";
  const doc = renderDocComment({
    style: opts.style,
    summary: `View ${className}.`,
    lines: shapedViewDocLines(view),
  });
  const content = `${header}${doc}export interface ${className}${extendsClause} {${interfaceBody}}\n`;
  return { path: generatePath, content };
}

function indexLine(view: View, ctx: TsCtx): string {
  return `export type { ${ctx.names.className(view.name)} } from "./${ctx.names.fileBase(view.name, "view-type")}";`;
}

const baseCreateGenerator = viewGenerator(renderView, indexLine);

/** Generator owns its options: DEFAULT_GENERATE_OPTIONS + datetime from settings; casing from CodegenNames; imports via TypescriptImports. */
export const createGenerator = () =>
  buildViewGenerator({
    baseCreateGenerator,
    imports: TypescriptImports,
    defaults: DEFAULT_GENERATE_OPTIONS,
    optionsFromSettings: datetimeOptionFromSettings,
  });
