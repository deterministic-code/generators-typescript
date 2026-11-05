import type { ParsedSettings } from "../../sdk/read-settings.ts";
import {
  generateServicesFiles,
  dispatchServicesStep,
  servicesStepGenerate,
} from "../../sdk/codegen/lib/services-generate.ts";
import { ImportPaths } from "../../sdk/import-paths.ts";
import {
  DEFAULT_COMMENT_STYLE,
  renderDocComment,
  type CommentStyle,
} from "../../sdk/generate-doc-comment.ts";
import type { CaseFormat } from "../../sdk/case.ts";
import type { CodegenNames } from "../../sdk/codegen-naming.ts";
import type { CodegenLayout } from "../../sdk/codegen-layout.ts";
import { libraryImportSpecifier } from "./library-import.ts";
import { serializeSampleValue } from "../../sdk/codegen/lib/ts-sample-literal.ts";
import {
  layoutFor,
  namesFor,
} from "../../sdk/codegen/lib/ts-codegen-naming.ts";
import { CodegenFieldNames } from "../../sdk/field-names.ts";
import { createTypeMapper } from "../../sdk/codegen/lib/type-mapper.ts";

type AbstractTypeMapper = (
  type: string,
  opts?: { datetime?: string },
) => string;

const mapAbstractType = createTypeMapper("typescript") as AbstractTypeMapper;

interface ByField {
  field: string;
  type: string;
}

interface ServiceCandidate {
  name: string;
  kind?: string;
  datasourceType?: string;
  byFields?: ByField[];
}

interface CustomServiceEntry {
  name: string;
  module?: string;
}

interface GenericServiceOptions {
  fileFormat?: CaseFormat;
  classFormat?: CaseFormat;
  fieldFormat?: CaseFormat;
  style?: CommentStyle;
  libraryReferenceMode?: string;
  organizeByFeature?: boolean;
  dirFormat?: CaseFormat;
  datetime?: string;
}

interface CustomStubOptions {
  fileFormat?: CaseFormat;
  style?: CommentStyle;
  methods?: string[];
  byFeature?: boolean;
  responseSamples?: Map<string, unknown>;
}

interface IndexOptions {
  fileFormat?: CaseFormat;
  classFormat?: CaseFormat;
  dirFormat?: CaseFormat;
}

interface GeneratedFile {
  path: string;
  content: string;
}

interface ServicesGenerateConfig {
  services: unknown;
  viewTypes: unknown;
  datasourceTypes: unknown;
  routes: unknown;
  settings: ParsedSettings;
  language: unknown;
}

/** The class body of typed `findBy<Field>` finders for a generic service's datasource-derived unique lookup keys — each delegates to the inherited `BaseService.findBy` and returns `T | null` (the key is unique). Empty when the entity has no lookup keys, preserving the empty-class output. */
function buildTsFinders(
  byFields: ByField[] | undefined,
  ctx: {
    typeName: string;
    names: CodegenNames;
    fieldFormat: CaseFormat;
    datetime?: string;
  },
): string {
  if (!Array.isArray(byFields) || byFields.length === 0) return "";
  const { typeName, names, fieldFormat, datetime } = ctx;
  const fieldNames = new CodegenFieldNames({ fieldFormat });
  const methods = byFields.map(({ field, type }) => {
    const param = fieldNames.name(field);
    const paramType = mapAbstractType(type, { datetime });
    return `  async ${names.finderMethod(field)}(${param}: ${paramType}): Promise<${typeName} | null> {
    const rows = await this.findBy([{ name: "${field}", value: ${param} }]);
    return rows[0] ?? null;
  }`;
  });
  return `\n${methods.join("\n\n")}\n`;
}

export const DEFAULT_GENERATE_OPTIONS = {
  createIndex: true,
  fileFormat: "Camel",
  style: DEFAULT_COMMENT_STYLE,
};

function serviceDocPair(args: {
  interfaceName: string;
  className: string;
  style: CommentStyle;
  datasourceType: string;
  target: string;
}): { ifaceDoc: string; classDoc: string } {
  const { interfaceName, className, style, datasourceType, target } = args;
  const descLines = [
    `Datasource type: ${datasourceType}.`,
    `Target: ${target}.`,
    `Fields: 0.`,
  ];
  return {
    ifaceDoc: renderDocComment({
      style,
      summary: `Service ${interfaceName}.`,
      lines: descLines,
    }),
    classDoc: renderDocComment({
      style,
      summary: `Service ${className}.`,
      lines: descLines,
    }),
  };
}

// A view service's generic is the view type; only a genuine datasource-entity service resolves to the datasource type. The layout helper owns the path in both layout modes.
function typeImportLine(
  candidate: ServiceCandidate,
  layout: CodegenLayout,
  ctx: { typeName: string },
): string {
  const artifact =
    candidate.kind === "datasource_type" ? "datasource-type" : "view-type";
  const typeImportPath = layout.importSpecifier(
    { entity: candidate.name, artifact: "service" },
    { entity: candidate.name, artifact },
  );
  return `import { ${ctx.typeName} } from "${typeImportPath}";\n`;
}

export function generateGenericService(
  candidate: ServiceCandidate,
  options: GenericServiceOptions = {},
): GeneratedFile {
  const {
    fileFormat = "Camel",
    classFormat = "Pascal",
    fieldFormat = "Camel",
    style = DEFAULT_COMMENT_STYLE,
    libraryReferenceMode,
    organizeByFeature = false,
    dirFormat,
    datetime,
  } = options;
  const layout = layoutFor({
    fileFormat,
    classFormat,
    dirFormat,
    organizeByFeature,
  });
  const { names } = layout;
  const typeName = names.className(candidate.name);
  const className = names.className(candidate.name, "service");
  const interfaceName = `I${className}`;
  const typeParams = `<${typeName}>`;
  const byFeature = organizeByFeature;
  const generatePath = layout.filePath(candidate.name, "service");
  const imports = typeImportLine(candidate, layout, { typeName });

  const { ifaceDoc, classDoc } = serviceDocPair({
    interfaceName,
    className,
    style,
    datasourceType: candidate.datasourceType ?? "standard",
    target: "StandardCrud",
  });

  const servicesImport = libraryImportSpecifier(
    "services",
    libraryReferenceMode,
    byFeature ? generatePath : `services/generated/${generatePath}`,
  );
  const finderBody = buildTsFinders(candidate.byFields, {
    typeName,
    names,
    fieldFormat,
    datetime,
  });
  const content = `${imports}import { BaseService, type IStandardCrudService } from "${servicesImport}";

${ifaceDoc}export type ${interfaceName} = IStandardCrudService${typeParams};

${classDoc}export class ${className} extends BaseService${typeParams} {${finderBody}}
`;
  return { path: generatePath, content };
}

// By-feature convention: every custom service lives at features/<deriveCustomEntity(name)>/custom/<fileBase>.ts (no leftover services/routes/custom/ at root — vertical-slice enforcement).
function conventionByFeaturePath(
  entry: CustomServiceEntry,
  names: CodegenNames,
): string {
  const fileBase = names.casedFileStem(entry.name);
  return ImportPaths.customStubPath({
    className: entry.name,
    fileBase,
    ext: ".ts",
  });
}

function moduleParts(mod: string): string[] {
  const parts = mod.split("/").filter((p) => p !== "" && p !== ".");
  while (parts.length && parts[0] === "..") parts.shift();
  return parts;
}

export function resolveCustomGeneratePath(
  entry: CustomServiceEntry,
  names: CodegenNames,
  byFeature = false,
): string {
  const fileBase = names.casedFileStem(entry.name);
  const mod = entry.module;

  if (byFeature) {
    if (!mod || typeof mod !== "string" || !mod.startsWith(".")) {
      // No module declared → convention-default placement.
      return conventionByFeaturePath(entry, names);
    }
    // Legacy module paths (./services/* or ./routes/*) silently relocated to convention so dogfooded YAML keeps working under by-feature; the generated app.ts hands createBackendApp a customModulePaths entry so the runtime resolves to the same place while the shipped contract stays verbatim.
    if (mod.startsWith("./services/") || mod.startsWith("./routes/")) {
      return conventionByFeaturePath(entry, names);
    }
    const parts = moduleParts(mod);
    if (parts[0] !== "features") {
      const suggestion = conventionByFeaturePath(entry, names);
      throw new Error(
        `generateCustomServiceStub: service "${entry.name}" has module "${mod}" which is outside ./features/. ` +
          `When organize=by-feature, custom services must live under features/<entity>/custom/. ` +
          `Drop the module: field to use the convention default (${suggestion.replace(/\.ts$/, "")}), ` +
          `or point module: into ./features/.`,
      );
    }
    return `${parts.join("/")}.ts`;
  }

  // by-layer: no convention, fall back to explicit module: or ../custom/.
  if (!mod || !mod.startsWith(".")) {
    return `../custom/${fileBase}.ts`;
  }
  const parts = moduleParts(mod);
  if (parts[0] === "services") parts.shift();
  return `../${parts.join("/")}.ts`;
}

export function generateCustomServiceStub(
  entry: CustomServiceEntry,
  options: CustomStubOptions = {},
): GeneratedFile {
  const {
    fileFormat = "Camel",
    style = DEFAULT_COMMENT_STYLE,
    methods = [],
    byFeature = false,
  } = options;
  const names = namesFor({ fileFormat });
  const className = entry.name;
  const interfaceName = `I${className}`;
  const { ifaceDoc, classDoc } = serviceDocPair({
    interfaceName,
    className,
    style,
    datasourceType: "standard",
    target: "Custom",
  });
  // For each routes.yaml-bound serviceMethod, generate a stub returning a schema-valid success sample of the route's declared response (the same `responseSamples` the Rust/C# stubs use, so all three languages return an identical HTTP-200 body for an un-implemented service). Falls back to `{}` for a method whose route declared no response schema. varargs unknown[] keeps the signature permissive for hand-edited subclasses since routes pass no args.
  const sampleFor = (m: string): unknown =>
    options.responseSamples instanceof Map
      ? options.responseSamples.get(m)
      : undefined;
  const bodyFor = (m: string): string => {
    const sample = sampleFor(m);
    return sample === undefined ? "{}" : serializeSampleValue(sample);
  };
  const interfaceBody =
    methods.length === 0
      ? ""
      : methods
          .map((m) => `  ${m}(..._args: unknown[]): Promise<unknown>;`)
          .join("\n");
  const classBody = [
    `  static readonly dependencies = [] as const;`,
    ...methods.map(
      (m) =>
        `  async ${m}(..._args: unknown[]): Promise<unknown> {\n    return ${bodyFor(m)};\n  }`,
    ),
  ].join("\n");
  const ifaceLines =
    methods.length === 0
      ? `export interface ${interfaceName} {}`
      : `export interface ${interfaceName} {\n${interfaceBody}\n}`;
  const content = `${ifaceDoc}${ifaceLines}

${classDoc}export class ${className} implements ${interfaceName} {
${classBody}
}
`;
  return { path: resolveCustomGeneratePath(entry, names, byFeature), content };
}

function indexExportLines(className: string, fileBase: string): string {
  return [
    `export { ${className} } from "./${fileBase}";`,
    `export type { I${className} } from "./${fileBase}";`,
  ].join("\n");
}

function indexLineForGeneric(entityName: string, names: CodegenNames): string {
  return indexExportLines(
    names.className(entityName, "service"),
    names.fileBase(entityName, "service"),
  );
}

function indexLineForCustom(
  entry: CustomServiceEntry,
  names: CodegenNames,
): string {
  return indexExportLines(entry.name, names.casedFileStem(entry.name));
}

export function generateIndexFromSchema(
  genericEntities: string[],
  customEntries: CustomServiceEntry[],
  options: IndexOptions = {},
): GeneratedFile[] {
  const { fileFormat = "Camel", classFormat = "Pascal", dirFormat } = options;
  const names = namesFor({ fileFormat, classFormat, dirFormat });
  const files: GeneratedFile[] = [];
  if (Array.isArray(genericEntities) && genericEntities.length > 0) {
    const sorted = [...genericEntities].sort((a, b) =>
      names.className(a).localeCompare(names.className(b)),
    );
    const body = sorted.map((n) => indexLineForGeneric(n, names)).join("\n");
    files.push({ path: "index.ts", content: `${body}\n` });
  }
  if (Array.isArray(customEntries) && customEntries.length > 0) {
    const customDirEntries = customEntries.filter(
      (e) => !e.module || !e.module.startsWith("."),
    );
    if (customDirEntries.length > 0) {
      const sorted = [...customDirEntries].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const body = sorted.map((e) => indexLineForCustom(e, names)).join("\n");
      files.push({ path: "../custom/index.ts", content: `${body}\n` });
    }
  }
  return files;
}

/** Catalog `services` step (typescript). */
export const generate = (ctx: unknown) =>
  servicesStepGenerate(
    {
      dispatchStep: dispatchServicesStep,
      generator: { createGenerator },
      language: "typescript",
    },
    ctx,
  );

/** Generator owns its render primitives + options; the shared orchestration in services-generate.ts does the rest. */
export const createGenerator = () => ({
  generate: (config: ServicesGenerateConfig) =>
    generateServicesFiles({
      ...config,
      primitives: {
        generateGenericService,
        generateCustomServiceStub,
        generateIndexFromSchema,
        defaultGenerateOptions: DEFAULT_GENERATE_OPTIONS,
      },
    }),
});
