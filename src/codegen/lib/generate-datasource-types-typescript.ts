import { DEFAULT_COMMENT_STYLE } from "../../sdk/generate-doc-comment.ts";
import { datasourceTypesGenerator } from "../../sdk/codegen-context.ts";
import { datasourceTypesModule } from "../../sdk/codegen/lib/generate-settings-options.ts";
import { normalizeDatasourceTable } from "../../sdk/codegen/lib/datasource-normalize.ts";
import { TypescriptImports } from "./typescript-imports.ts";
import { createTypeMapper } from "../../sdk/codegen/lib/type-mapper.ts";
import { datasourceSettingsFor } from "../../sdk/codegen/lib/ts-datasource-settings.ts";
import { datasourceTypeDoc } from "../../sdk/codegen/lib/datasource-types-generate-types.ts";
import type {
  DatasourceField,
  GenerateCtx,
  GeneratedFile,
  NormalizedTable,
} from "../../sdk/codegen/lib/datasource-types-generate-types.ts";

interface TsGenerateOptions {
  baseClass: string;
  language: string;
  schemaVersion: string;
  style: unknown;
  idType?: string;
  datetime?: string;
  withUuidColumn?: boolean;
  libraryReferenceMode?: string;
}

type TsCtx = GenerateCtx<TsGenerateOptions, TypescriptImports>;

export const DEFAULT_GENERATE_OPTIONS: TsGenerateOptions = {
  baseClass: "StandardDataSource",
  language: "typescript",
  schemaVersion: "1.0",
  style: DEFAULT_COMMENT_STYLE,
};

const mapAbstractType = createTypeMapper("typescript");

function normalizeTable(entry: unknown): NormalizedTable {
  return normalizeDatasourceTable(entry);
}

function mapType(type: string, datetime: string | undefined): string {
  return mapAbstractType(type, { datetime });
}

function generateField(field: DatasourceField, ctx: TsCtx): string {
  const ds = datasourceSettingsFor(ctx.opts);
  const tsType = ds.referenceIsUuid(field.references)
    ? ds.tsIdType()
    : mapType(field.type, ctx.opts.datetime);
  const nullable = field.isNullable ? " | null" : "";
  return `  ${ctx.fields.ident(field.name)}: ${tsType}${nullable};`;
}

export function resolveBaseClass({
  idType,
  withUuidColumn,
  datetime,
}: {
  idType?: string;
  withUuidColumn?: boolean;
  datetime?: string;
}): { baseClass: string; imports: string[]; typeArgs: string[] } {
  const baseClass = withUuidColumn
    ? "StandardDataSourceWithUuid"
    : "StandardDataSource";
  const idT = datasourceSettingsFor({ idType }).tsIdType();
  const dtT = datetime === "string" ? "string" : "Date";
  const typeArgs = withUuidColumn ? [idT, "string", dtT] : [idT, dtT];
  return { baseClass, imports: [baseClass], typeArgs };
}

function renderTable(table: NormalizedTable, ctx: TsCtx): GeneratedFile {
  const { names, opts, layout, imports: importer } = ctx;
  const className = names.className(table.name);

  const withUuidColumn =
    datasourceSettingsFor(opts).withUuidColumn && opts.withUuidColumn;
  const { baseClass, imports, typeArgs } = resolveBaseClass({
    idType: opts.idType,
    withUuidColumn,
    datetime: opts.datetime,
  });

  const bodyFields = withUuidColumn
    ? table.fields
    : table.fields.filter((f) => f.name !== "uuid");
  const body = bodyFields.map((f) => generateField(f, ctx)).join("\n");

  const doc = datasourceTypeDoc({
    className,
    datasourceType: table.datasourceType,
    fieldCount: bodyFields.length,
    style: opts.style,
  });

  const generatePath = layout.filePath(table.name, "datasource-type");
  const typesImport = importer.library("types", opts.libraryReferenceMode, {
    entity: table.name,
    artifact: "datasource-type",
  });
  const content = `// schema-version: ${opts.schemaVersion}
import type { ${imports.join(", ")} } from "${typesImport}";

${doc}export interface ${className} extends ${baseClass}<${typeArgs.join(", ")}> {
${body}
}
`;
  return { path: generatePath, content };
}

function indexLine(table: NormalizedTable, ctx: TsCtx): string {
  return `export { ${ctx.names.className(table.name)} } from "./${ctx.names.fileBase(table.name, "datasource-type")}";`;
}

const baseGenerate = datasourceTypesGenerator(
  normalizeTable,
  renderTable,
  indexLine,
)(TypescriptImports);

export const { render, createGenerator, generate } = datasourceTypesModule({
  baseGenerate,
  defaultGenerateOptions: DEFAULT_GENERATE_OPTIONS,
  language: "typescript",
});
