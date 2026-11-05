import {
  generateRoutesFiles,
  dispatchRoutesStep,
  routesStepGenerate,
} from "../../sdk/codegen/lib/routes-generate.ts";
import {
  generateNestedDirectFkRouter,
  generateNestedM2mRouter,
} from "./generate-nested-routes-typescript.ts";
import {
  snakeToCamel,
  snakeToKebab,
  camelPlural,
} from "../../sdk/case.ts";
import { kebab } from "../../sdk/case.ts";
import { ImportPaths } from "../../sdk/import-paths.ts";
import {
  DEFAULT_COMMENT_STYLE,
  renderDocComment,
  type CommentStyle,
} from "../../sdk/generate-doc-comment.ts";
import type { CodegenNames } from "../../sdk/codegen-naming.ts";
import { libraryImportSpecifier } from "./library-import.ts";
import { entityUsesOptimisticConcurrency } from "../../sdk/lib/generate-sql.ts";
import {
  namesFor,
  layoutFor,
  type NamesForOptions,
} from "../../sdk/codegen/lib/ts-codegen-naming.ts";
import type {
  GeneratedFile,
  RoutesGenerateConfig,
} from "../../sdk/codegen/lib/routes-generate-types.ts";

interface RouteGenerateOptions extends NamesForOptions {
  style?: CommentStyle;
  libraryReferenceMode?: string;
  useOptimisticConcurrency?: boolean;
  customServiceEntities?: Set<string>;
  byFeature?: boolean;
}

interface Enrichment {
  targetTable: string;
  fkColumn?: string;
  prefix?: string;
}

interface ByFieldEntry {
  byField: string;
  methods?: string[];
  byFieldUnique?: boolean;
}

interface RouteCandidate {
  name: string;
  datasourceType?: string;
  optimisticConcurrency?: boolean;
  enrichments?: Enrichment[];
  byFields?: ByFieldEntry[];
}

interface RouteLibImports {
  services: string;
  routes: string;
  responses: string;
  errors: string;
}

interface RouteHead {
  entity: string;
  fnName: string;
  opts: RouteGenerateOptions;
  generatePath: string;
  style: CommentStyle;
  serviceImport: string;
  libImports: RouteLibImports;
}

interface OptionLines {
  flat: string;
  nested: string;
}

type CustomRouteDef = { routeClass?: string; module?: string };
type RouteEntry = Record<string, unknown>;

export function routeServiceImport(
  opts: RouteGenerateOptions,
  fromEntity: string,
  targetEntity: string,
): string {
  const customServiceEntities = opts.customServiceEntities ?? new Set<string>();
  // lookup key into a Set of kebab feature dirs (ImportPaths.featureEntity output); not an generated name.
  const targetSubdir = customServiceEntities.has(kebab(targetEntity)) // lint-generator-casing-allow: kebab
    ? "custom"
    : undefined;
  return layoutFor(opts).importSpecifier(
    { entity: fromEntity, artifact: "route" },
    { entity: targetEntity, artifact: "service" },
    { targetSubdir },
  );
}

export function routeValidatorImport(
  opts: RouteGenerateOptions,
  fromEntity: string,
  targetEntity: string,
): string {
  return layoutFor(opts).importSpecifier(
    { entity: fromEntity, artifact: "route" },
    { entity: targetEntity, artifact: "view-validator" },
  );
}

function routeImports(
  libraryReferenceMode: string | undefined,
  fileRelPath: string,
): RouteLibImports {
  return {
    services: libraryImportSpecifier(
      "services",
      libraryReferenceMode,
      fileRelPath,
    ),
    routes: libraryImportSpecifier("routes", libraryReferenceMode, fileRelPath),
    responses: libraryImportSpecifier(
      "responses",
      libraryReferenceMode,
      fileRelPath,
    ),
    errors: libraryImportSpecifier("errors", libraryReferenceMode, fileRelPath),
  };
}

export const DEFAULT_GENERATE_OPTIONS = {
  createIndex: true,
  fileFormat: "Camel",
  style: DEFAULT_COMMENT_STYLE,
};

function routeFilePlan(
  candidate: RouteCandidate,
  opts: RouteGenerateOptions,
): { generatePath: string; fileRelPath: string } {
  const byFeature = opts.organizeByFeature === true;
  const fileBase = namesFor(opts).fileBase(candidate.name, "route");
  const generatePath = layoutFor(opts).filePath(candidate.name, "route");
  const fileRelPath = byFeature ? generatePath : `routes/generated/${fileBase}.ts`;
  return { generatePath, fileRelPath };
}

function routeHead(
  candidate: RouteCandidate,
  options: RouteGenerateOptions,
): RouteHead {
  const opts = { ...options, fileFormat: options.fileFormat ?? "Camel" };
  const { generatePath, fileRelPath } = routeFilePlan(candidate, opts);
  const names = namesFor(opts);
  return {
    entity: names.className(candidate.name),
    fnName: `${camelPlural(candidate.name)}Router`, // lint-generator-casing-allow: camelPlural

    opts,
    generatePath,
    style: options.style ?? DEFAULT_COMMENT_STYLE,
    serviceImport: routeServiceImport(opts, candidate.name, candidate.name),
    libImports: routeImports(options.libraryReferenceMode, fileRelPath),
  };
}

interface CrudByFieldsHeaderArgs {
  entity: string;
  byFields: ByFieldEntry[];
  serviceImport: string;
  libImports: RouteLibImports;
}

function crudByFieldsHeader({
  entity,
  byFields,
  serviceImport,
  libImports,
}: CrudByFieldsHeaderArgs): { block: string; header: string } {
  const block = byFieldsBlock(entity, byFields);
  const needsZod = byFieldsNeedsZod(byFields);
  const zodErrorImport = needsZod
    ? `\nimport { handleZodError } from "${libImports.errors}";`
    : "";
  const header = `import { Router } from "express";
import type { ZodSchema } from "zod";
import { I${entity}Service } from "${serviceImport}";
import { createCrudRouter } from "${libImports.routes}";
import { sendError, sendItem, sendItems } from "${libImports.responses}";${zodErrorImport}`;
  return { block, header };
}

interface ByFieldRouteCtx {
  entity: string;
  byField: string;
  fieldCamel: string;
  fieldKebab: string;
  unique: boolean;
  indent: string;
}

function byFieldGetBlock(ctx: ByFieldRouteCtx): string {
  const { entity, byField, fieldCamel, fieldKebab, unique, indent } = ctx;
  if (unique) {
    return `${indent}router.get("/${fieldKebab}/:${fieldCamel}", async (req, res, next) => {
${indent}  try {
${indent}    const value = req.params.${fieldCamel} ?? "";
${indent}    const rows = await service.findBy([{ name: "${byField}", value }]);
${indent}    if (rows.length === 0) {
${indent}      sendError(res, 404, "NOT_FOUND", \`${entity} with ${byField} '\${value}' not found\`);
${indent}      return;
${indent}    }
${indent}    if (rows.length > 1) {
${indent}      sendError(res, 409, "CONFLICT", \`Multiple ${entity} rows matched ${byField}='\${value}'\`);
${indent}      return;
${indent}    }
${indent}    sendItem(res, rows[0] as unknown as Record<string, unknown>);
${indent}  } catch (err) {
${indent}    next(err);
${indent}  }
${indent}});`;
  }
  return `${indent}router.get("/${fieldKebab}/:${fieldCamel}", async (req, res, next) => {
${indent}  try {
${indent}    const value = req.params.${fieldCamel} ?? "";
${indent}    const rows = await service.findBy([{ name: "${byField}", value }]);
${indent}    sendItems(res, rows as unknown[]);
${indent}  } catch (err) {
${indent}    next(err);
${indent}  }
${indent}});`;
}

/** The 404-if-nothing-matched guard shared by every byField mutation (unique PUT/DELETE and non-unique DELETE). */
function notFoundIfZero(
  entity: string,
  byField: string,
  indent: string,
): string {
  return `${indent}    if (count === 0) {
${indent}      sendError(res, 404, "NOT_FOUND", \`${entity} with ${byField} '\${value}' not found\`);
${indent}      return;
${indent}    }`;
}

/** The 404-if-none / 409-if-many guards a unique byField mutation shares between PUT and DELETE. */
function uniqueCountGuards(
  entity: string,
  byField: string,
  indent: string,
): string {
  return `${notFoundIfZero(entity, byField, indent)}
${indent}    if (count > 1) {
${indent}      sendError(res, 409, "CONFLICT", \`Multiple ${entity} rows matched ${byField}='\${value}'\`);
${indent}      return;
${indent}    }`;
}

function byFieldPutBlock(ctx: ByFieldRouteCtx): string {
  const { entity, byField, fieldCamel, fieldKebab, unique, indent } = ctx;
  const head = `${indent}router.put("/${fieldKebab}/:${fieldCamel}", async (req, res, next) => {
${indent}  try {
${indent}    const value = req.params.${fieldCamel} ?? "";
${indent}    const parsed = updateSchema.parse(req.body);
${indent}    const count = await service.updateBy(
${indent}      [{ name: "${byField}", value }],
${indent}      parsed as Record<string, unknown>,
${indent}    );`;
  const outcome = unique
    ? `${uniqueCountGuards(entity, byField, indent)}
${indent}    const rows = await service.findBy([{ name: "${byField}", value }]);
${indent}    sendItem(res, (rows[0] ?? null) as unknown as Record<string, unknown>);`
    : `${indent}    sendItem(res, { count });`;
  const tail = `${indent}  } catch (err) {
${indent}    if (handleZodError(err, res)) return;
${indent}    next(err);
${indent}  }
${indent}});`;
  return `${head}
${outcome}
${tail}`;
}

function byFieldDeleteBlock(ctx: ByFieldRouteCtx): string {
  const { entity, byField, fieldCamel, fieldKebab, unique, indent } = ctx;
  if (unique) {
    return `${indent}router.delete("/${fieldKebab}/:${fieldCamel}", async (req, res, next) => {
${indent}  try {
${indent}    const value = req.params.${fieldCamel} ?? "";
${indent}    const count = await service.deleteBy([{ name: "${byField}", value }]);
${uniqueCountGuards(entity, byField, indent)}
${indent}    sendItem(res, { success: true });
${indent}  } catch (err) {
${indent}    next(err);
${indent}  }
${indent}});`;
  }
  return `${indent}router.delete("/${fieldKebab}/:${fieldCamel}", async (req, res, next) => {
${indent}  try {
${indent}    const value = req.params.${fieldCamel} ?? "";
${indent}    const count = await service.deleteBy([{ name: "${byField}", value }]);
${notFoundIfZero(entity, byField, indent)}
${indent}    sendItem(res, { count });
${indent}  } catch (err) {
${indent}    next(err);
${indent}  }
${indent}});`;
}

function byFieldRouteCode(
  entity: string,
  entry: ByFieldEntry,
  indent = "  ",
): string {
  const byField = entry.byField;
  // fieldCamel is a JS route-param identifier (camelCase invariant); fieldKebab is a URL path segment (kebab invariant) — neither is a settings-driven entity name.
  const fieldCamel = snakeToCamel(byField); // lint-generator-casing-allow: snakeToCamel
  const fieldKebab = snakeToKebab(byField); // lint-generator-casing-allow: snakeToKebab
  const methods = Array.isArray(entry.methods)
    ? entry.methods
    : ["GET", "PUT", "DELETE"];
  const unique = entry.byFieldUnique === true;
  const ctx: ByFieldRouteCtx = {
    entity,
    byField,
    fieldCamel,
    fieldKebab,
    unique,
    indent,
  };
  const blocks: string[] = [];
  if (methods.includes("GET")) blocks.push(byFieldGetBlock(ctx));
  if (methods.includes("PUT")) blocks.push(byFieldPutBlock(ctx));
  if (methods.includes("DELETE")) blocks.push(byFieldDeleteBlock(ctx));
  return blocks.join("\n");
}

function byFieldsBlock(entity: string, entries: ByFieldEntry[]): string {
  return entries.map((e) => byFieldRouteCode(entity, e, "  ")).join("\n\n");
}

function byFieldsNeedsZod(entries: ByFieldEntry[]): boolean {
  return entries.some((e) =>
    (Array.isArray(e.methods) ? e.methods : ["GET", "PUT", "DELETE"]).includes(
      "PUT",
    ),
  );
}

function readOnlyDoc(
  candidate: RouteCandidate,
  style: CommentStyle,
  fnName: string,
): string {
  return renderDocComment({
    style,
    summary: `Route ${fnName}.`,
    lines: [
      `Datasource type: ${candidate.datasourceType ?? "readonly-lookup"}.`,
      `Target: ReadOnlyRouter.`,
      `Fields: 0.`,
    ],
  });
}

function readOnlyPlain(
  head: RouteHead,
  doc: string,
  optionLines: OptionLines,
): GeneratedFile {
  const { entity, fnName, generatePath, serviceImport, libImports } = head;
  const content = `import { Router } from "express";
import { I${entity}Service } from "${serviceImport}";
import { createReadOnlyRouter } from "${libImports.routes}";

${doc}export function ${fnName}(service: I${entity}Service): Router {
  return createReadOnlyRouter({
    service,
    entityName: "${entity}",${optionLines.flat}
  });
}
`;
  return { path: generatePath, content };
}

function readOnlyWithByFields(
  head: RouteHead,
  doc: string,
  args: { byFields: ByFieldEntry[]; optionLines: OptionLines },
): GeneratedFile {
  const { entity, fnName, generatePath, serviceImport, libImports } = head;
  const block = byFieldsBlock(entity, args.byFields);
  const content = `import { Router } from "express";
import { I${entity}Service } from "${serviceImport}";
import { createReadOnlyRouter } from "${libImports.routes}";
import { sendItem, sendItems } from "${libImports.responses}";

${doc}export function ${fnName}(service: I${entity}Service): Router {
  const router = Router();

${block}

  router.use(
    createReadOnlyRouter({
      service,
      entityName: "${entity}",${args.optionLines.nested}
    }),
  );
  return router;
}
`;
  return { path: generatePath, content };
}

export function generateReadOnlyRouter(
  candidate: RouteCandidate,
  options: RouteGenerateOptions = {},
): GeneratedFile {
  const head = routeHead(candidate, options);
  const byFields = (candidate.byFields ?? []).map((e) => ({
    ...e,
    methods: Array.isArray(e.methods)
      ? e.methods.filter((m) => m === "GET")
      : ["GET"],
  }));
  const optionLines = routerOptionLines(candidate);
  const doc = readOnlyDoc(candidate, head.style, head.fnName);
  // Always plain: enrichment lives in the composed service the facade forwards to.
  if (byFields.length === 0) {
    return readOnlyPlain(head, doc, optionLines);
  }
  return readOnlyWithByFields(head, doc, { byFields, optionLines });
}

function routerOptionLines(
  _candidate: RouteCandidate,
  useOptimisticConcurrency = false,
): OptionLines {
  const occ = (indent: string) =>
    useOptimisticConcurrency
      ? `\n${indent}useOptimisticConcurrency: true,`
      : "";
  return { flat: occ("    "), nested: occ("      ") };
}

function crudDoc(
  candidate: RouteCandidate,
  style: CommentStyle,
  fnName: string,
): string {
  return renderDocComment({
    style,
    summary: `Route ${fnName}.`,
    lines: [
      `Datasource type: ${candidate.datasourceType ?? "standard"}.`,
      `Target: CrudRouter.`,
      `Fields: 0.`,
    ],
  });
}

function crudPlain(
  head: RouteHead,
  doc: string,
  args: { optionLines: OptionLines },
): GeneratedFile {
  const { entity, fnName, generatePath, serviceImport, libImports } = head;
  const content = `import { Router } from "express";
import type { ZodSchema } from "zod";
import { I${entity}Service } from "${serviceImport}";
import { createCrudRouter } from "${libImports.routes}";

${doc}export function ${fnName}(service: I${entity}Service, createSchema: ZodSchema, updateSchema: ZodSchema): Router {
  return createCrudRouter({
    service,
    createSchema,
    updateSchema,
    entityName: "${entity}",${args.optionLines.flat}
  });
}
`;
  return { path: generatePath, content };
}

function crudWithByFields(
  head: RouteHead,
  doc: string,
  args: {
    byFields: ByFieldEntry[];
    optionLines: OptionLines;
  },
): GeneratedFile {
  const { entity, fnName, generatePath, serviceImport, libImports } = head;
  const { block, header } = crudByFieldsHeader({
    entity,
    byFields: args.byFields,
    serviceImport,
    libImports,
  });
  const content = `${header}

${doc}export function ${fnName}(service: I${entity}Service, createSchema: ZodSchema, updateSchema: ZodSchema): Router {
  const router = Router();

${block}

  router.use(
    createCrudRouter({
      service,
      createSchema,
      updateSchema,
      entityName: "${entity}",${args.optionLines.nested}
    }),
  );
  return router;
}
`;
  return { path: generatePath, content };
}

export function generateCrudRouter(
  candidate: RouteCandidate,
  options: RouteGenerateOptions = {},
): GeneratedFile {
  const useOptimisticConcurrency = entityUsesOptimisticConcurrency(
    candidate,
    options.useOptimisticConcurrency === true,
  );
  const head = routeHead(candidate, options);
  const byFields = candidate.byFields ?? [];
  const optionLines = routerOptionLines(candidate, useOptimisticConcurrency);
  const doc = crudDoc(candidate, head.style, head.fnName);
  // Always plain: read-enrich + write-resolve live in the composed LookupEnrichedService the facade forwards to, so the router carries no enrich hooks or lookup params. Body schemas arrive as params from the composer (ctx.bodySchema), the same buildBodySchema the dynamic path uses.
  if (byFields.length === 0) {
    return crudPlain(head, doc, { optionLines });
  }
  return crudWithByFields(head, doc, {
    byFields,
    optionLines,
  });
}

// By-feature convention for custom routes: features/<deriveCustomEntity(routeClass)>/custom/<fileBase>.ts (e.g. hostInfo + routeClass HostInfoRoute -> features/host-info/custom/host-info-route.ts).
function conventionByFeatureRoutePath(
  entry: RouteEntry,
  names: CodegenNames,
): string {
  const name = Object.keys(entry)[0];
  const raw = entry[name];
  const def = (raw && typeof raw === "object" ? raw : {}) as CustomRouteDef;
  const fileBase = names.customRouteFileBase(name);
  // Prefer explicit routeClass (matches runtime-instantiated constructor); fall back to "<name>Route".
  const className =
    typeof def.routeClass === "string" && def.routeClass.length > 0
      ? def.routeClass
      : `${name}Route`;
  return ImportPaths.customStubPath({ className, fileBase, ext: ".ts" });
}

function routeModuleParts(mod: string): string[] {
  const parts = mod.split("/").filter((p) => p !== "" && p !== ".");
  while (parts.length && parts[0] === "..") parts.shift();
  return parts;
}

function byFeatureRoutePath({
  entry,
  names,
  name,
  mod,
}: {
  entry: RouteEntry;
  names: CodegenNames;
  name: string;
  mod: string | null | undefined;
}): string {
  const isRelative = typeof mod === "string" && mod.startsWith(".");
  const isLegacyLayer =
    isRelative &&
    (mod.startsWith("./services/") || mod.startsWith("./routes/"));
  if (!isRelative || isLegacyLayer) {
    return conventionByFeatureRoutePath(entry, names);
  }
  const parts = routeModuleParts(mod);
  if (parts[0] !== "features") {
    const suggestion = conventionByFeatureRoutePath(entry, names);
    throw new Error(
      `generateCustomRouteStub: route "${name}" has module "${mod}" which is outside ./features/. ` +
        `When organize=by-feature, custom routes must live under features/<entity>/custom/. ` +
        `Drop the module: field to use the convention default (${suggestion.replace(/\.ts$/, "")}), ` +
        `or point module: into ./features/.`,
    );
  }
  return `${parts.join("/")}.ts`;
}

// Mirrors resolveCustomGeneratePath in services generator. Under by-feature the runtime's loadClass() must find the stub at exactly the path generated, so the generated app.ts hands createBackendApp a customModulePaths entry pointing at the convention path when the user didn't set one.
export function resolveCustomRoutePath(
  entry: RouteEntry,
  names: CodegenNames,
  byFeature = false,
): string {
  const name = Object.keys(entry)[0];
  const raw = entry[name];
  const fileBase = names.customRouteFileBase(name);
  const mod =
    raw && typeof raw === "object" ? (raw as CustomRouteDef).module : null;

  if (byFeature) {
    return byFeatureRoutePath({ entry, names, name, mod });
  }

  if (!mod || typeof mod !== "string" || !mod.startsWith(".")) {
    return `../custom/${fileBase}.ts`;
  }
  const parts = routeModuleParts(mod);
  if (parts[0] === "routes") parts.shift();
  return `../${parts.join("/")}.ts`;
}

export function generateCustomRouteStub(
  entry: RouteEntry,
  options: RouteGenerateOptions & { byFeature?: boolean } = {},
): GeneratedFile {
  const { style = DEFAULT_COMMENT_STYLE, byFeature = false } = options;
  const [name] = Object.keys(entry);
  const names = namesFor({
    ...options,
    fileFormat: options.fileFormat ?? "Camel",
  });
  const className = `${names.className(name)}Route`;
  const interfaceName = `I${className}`;
  const descLines = [
    `Datasource type: standard.`,
    `Target: CustomRoute.`,
    `Fields: 0.`,
  ];
  const ifaceDoc = renderDocComment({
    style,
    summary: `Route ${interfaceName}.`,
    lines: descLines,
  });
  const classDoc = renderDocComment({
    style,
    summary: `Route ${className}.`,
    lines: descLines,
  });
  // Generated app.ts does `new <RouteClass>(svc, ...).router()`; stub must accept any constructor args and return a real Router or tsc fails (TS2554/TS2339); 501 placeholder keeps a partially-stubbed app booting with clear "not implemented" instead of 404.
  const content = `import { Router } from "express";

${ifaceDoc}export interface ${interfaceName} {
  router(): Router;
}

${classDoc}export class ${className} implements ${interfaceName} {
  static readonly dependencies = [] as const;
  constructor(..._args: unknown[]) {}
  router(): Router {
    const r = Router();
    r.use((_req, res) => res.status(501).json({ error: "stub route ${className}" }));
    return r;
  }
}
`;
  return {
    path: resolveCustomRoutePath(entry, names, byFeature),
    content,
  };
}

function dirOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
}

function basenameNoExt(p: string): string {
  const idx = p.lastIndexOf("/");
  const stem = idx === -1 ? p : p.slice(idx + 1);
  return stem.replace(/\.ts$/, "");
}

function parseExports(content: string): {
  valueNames: Set<string>;
  typeNames: Set<string>;
} {
  const valueNames = new Set<string>();
  const typeNames = new Set<string>();
  const re =
    /^\s*export\s+(?:async\s+)?(type|interface|class|function|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const kind = m[1];
    const name = m[2];
    if (kind === "type" || kind === "interface") {
      typeNames.add(name);
    } else {
      valueNames.add(name);
    }
  }
  return { valueNames, typeNames };
}

interface IndexSibling {
  stem: string;
  valueNames: Set<string>;
  typeNames: Set<string>;
}

function groupSiblingsByDir(files: GeneratedFile[]): Map<string, IndexSibling[]> {
  const byDir = new Map<string, IndexSibling[]>();
  for (const f of files) {
    const dir = dirOf(f.path);
    const stem = basenameNoExt(f.path);
    if (stem === "index") continue;
    let siblings = byDir.get(dir);
    if (!siblings) {
      siblings = [];
      byDir.set(dir, siblings);
    }
    siblings.push({ stem, ...parseExports(f.content) });
  }
  return byDir;
}

function indexLinesForSiblings(siblings: IndexSibling[]): string[] {
  siblings.sort((a, b) => a.stem.localeCompare(b.stem));
  const lines: string[] = [];
  for (const s of siblings) {
    const valueList = [...s.valueNames].sort();
    const typeList = [...s.typeNames].sort();
    if (valueList.length > 0) {
      lines.push(`export { ${valueList.join(", ")} } from "./${s.stem}";`);
    }
    if (typeList.length > 0) {
      lines.push(`export type { ${typeList.join(", ")} } from "./${s.stem}";`);
    }
  }
  return lines;
}

export function generateIndexFromFiles(files: GeneratedFile[]): GeneratedFile[] {
  const indexFiles: GeneratedFile[] = [];
  for (const [dir, siblings] of groupSiblingsByDir(files)) {
    if (siblings.length === 0) continue;
    const lines = indexLinesForSiblings(siblings);
    if (lines.length === 0) continue;
    const path = dir ? `${dir}/index.ts` : "index.ts";
    indexFiles.push({ path, content: `${lines.join("\n")}\n` });
  }
  return indexFiles;
}

interface WiringRouter {
  name: string;
  readOnly?: boolean;
}

interface AppWiringInput {
  routers: WiringRouter[];
}

/** The app-wiring aggregator is cross-entity: flat leaves the stem bare (the routes step prefixes routes/generated/), by-feature nests it under features/ so the feature index wires it. */
function appWiringPlacement(byFeature: boolean): {
  generatePath: string;
  fileRelPath: string;
} {
  return byFeature
    ? {
        generatePath: "features/app-wiring.ts",
        fileRelPath: "features/app-wiring.ts",
      }
    : {
        generatePath: "app-wiring.ts",
        fileRelPath: "routes/generated/app-wiring.ts",
      };
}

/** The generated app-wiring: `composeRouter(ctx)` mounts each generated router at its `/api/<plural>` path, forwarding to the composed service (`ctx.entityService`). The runtime's routeComposer hook calls this — the single live source of truth. Mirrors the Rust app_wiring. */
export function generateAppWiring(
  wiring: AppWiringInput,
  options: RouteGenerateOptions = {},
): GeneratedFile {
  const opts = { ...options, fileFormat: options.fileFormat ?? "Camel" };
  const byFeature = opts.organizeByFeature === true;
  const names = namesFor(opts);
  const layout = layoutFor(opts);
  const { generatePath, fileRelPath } = appWiringPlacement(byFeature);
  const appImport = libraryImportSpecifier(
    "app",
    options.libraryReferenceMode,
    fileRelPath,
  );
  const routerImportPath = (name: string): string => {
    const stem = names.fileBase(name, "route");
    return byFeature
      ? `./${layout.featureDir(name, "route")}/${stem}.js`
      : `./${stem}.js`;
  };
  const imports = wiring.routers.map((r) => {
    const fnName = `${camelPlural(r.name)}Router`; // lint-generator-casing-allow: camelPlural
    return `import { ${fnName} } from "${routerImportPath(r.name)}";`;
  });
  const mounts = wiring.routers.map((r) => {
    const fnName = `${camelPlural(r.name)}Router`; // lint-generator-casing-allow: camelPlural
    const key = JSON.stringify(r.name);
    const args = r.readOnly
      ? `ctx.entityService(${key})`
      : `ctx.entityService(${key}), ctx.bodySchema(${key}, "create"), ctx.bodySchema(${key}, "update")`;
    return `  router.use("/api/${layout.apiPath(r.name)}", ${fnName}(${args}));`;
  });
  const body =
    mounts.length > 0
      ? `${mounts.join("\n")}\n  return router;`
      : `  return router;`;
  const content = `import { Router } from "express";
import type { RouteComposeContext } from "${appImport}";
${imports.join("\n")}

/** Mounts each generated router, forwarding to its composed service — the live CRUD/enrich/eager path. */
export function composeRouter(ctx: RouteComposeContext): Router {
  const router = Router();
${body}
}
`;
  return { path: generatePath, content };
}

/** Catalog `routes` step (typescript). */
export const generate = (ctx: unknown) =>
  routesStepGenerate(
    {
      dispatchStep: dispatchRoutesStep,
      generator: { createGenerator },
      language: "typescript",
    },
    ctx,
  );

export const createGenerator = () => ({
  generate: (config: RoutesGenerateConfig) =>
    generateRoutesFiles({
      ...config,
      primitives: {
        generateCrudRouter,
        generateReadOnlyRouter,
        generateCustomRouteStub,
        generateAppWiring,
        generateIndexFromFiles,
        nestedRouterGenerators: {
          "direct-fk": generateNestedDirectFkRouter,
          m2m: generateNestedM2mRouter,
        },
      },
    }),
});
