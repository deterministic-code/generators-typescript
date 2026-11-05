import { DEFAULT_LANGUAGE } from "../../lib/codegen-steps-constants.ts";
import { emptyGenerateResult } from "./generate-result.ts";
import { catalogStepGenerate } from "./catalog-step-generate.ts";
import { parse } from "yaml";
import {
  expandViewTypes,
  routeViewTypeDirective,
} from "../../view-expand.ts";
import type { Enrichment } from "../../view-expand.ts";
import { indexDatasourceByName } from "../../lib/datasource-index.ts";
import { idTypeFromSettings } from "./ts-datasource-settings.ts";
import {
  collectCombinedChildNames,
  columnIsUnique,
  expandRoutes,
} from "../../lib/routes-expand.ts";
import {
  extractEagerWriteChildren,
  buildEagerWriteChildrenClosure,
} from "./eager-write-children.ts";
import { collectCombinedRouteDescriptors } from "./iterate-combined-routes.ts";
import { parseByFieldEntry } from "../../lib/by-field-discovery.ts";
import { datasourceSettingsForSettings } from "./ts-datasource-settings.ts";
import { caseOptionsFromSettings } from "./ts-codegen-naming.ts";
import { ImportPaths } from "../../import-paths.ts";
import {
  ensureHealthServiceFirst,
  ensureHealthRouteFirst,
} from "./seed-healthcheck-yaml.ts";
import { DEFAULT_COMMENT_STYLE } from "../../generate-doc-comment.ts";
import {
  resolveLibraryReferenceMode,
  SUPPORTED_LANGUAGES,
} from "../../read-settings.ts";
import { inferPkForCandidate } from "./infer-pk-for-candidate.ts";
import { buildRouteCandidates } from "./route-candidates.ts";
import { compileRoutesFilter } from "../../lib/compile-filter.ts";
import { hasNoRouteSurface } from "../../lib/routes-expand.ts";
import { resolveLanguage } from "./resolve-language.ts";
import { validateViewAndDatasource } from "./script-input.ts";
import { resolveStepInputs } from "./deterministic-inputs.ts";
import { organizeLayoutFromSettings } from "./generate-settings-options.ts";
import type { ParsedSettings } from "../../read-settings.ts";
import type {
  RawTypesDoc,
  RawTypeDef,
  RawFieldEntry,
  RawFieldDef,
  RawIncludeEntry,
  RouteViewTypeDirective,
} from "../../deterministic-shapes.ts";
import type { CaseFormat } from "../../case.ts";
import type { CommentStyle } from "../../generate-doc-comment.ts";
import type { DatasourceSettings } from "../../datasource-settings.ts";
import type { GeneratedFile, RoutesGenerateConfig } from "./routes-generate-types.ts";

type ValidatedDocs = Awaited<ReturnType<typeof validateViewAndDatasource>>;
type DatasourceData = Extract<
  ValidatedDocs,
  { viewData: RawTypesDoc }
>["datasourceData"];

interface RouteDefEntry {
  entity?: string;
  byField?: string;
  methods?: string[];
}

type RouteEntry = Record<string, RouteDefEntry>;

/** A parsed routes doc — only the fields the generate dispatcher reads directly; library helpers receive it via their own doc types. */
interface RoutesData {
  routes?: RouteEntry[];
  includes?: RawIncludeEntry[];
}

interface ServicesData {
  services?: Array<{ name?: string }>;
}

interface ByFieldEntry {
  byField: string;
  methods?: string[];
  byFieldUnique?: boolean;
}

interface FieldSummary {
  name: string;
  type: string;
  isNullable: boolean;
}

interface PkInfo {
  column: string;
  idType: string;
}

type InferredPk = NonNullable<ReturnType<typeof inferPkForCandidate>>;
type ChildSpec = ReturnType<typeof extractEagerWriteChildren>[number];

interface RouteCandidate {
  name: string;
  kind?: string;
  datasourceType?: string;
  optimisticConcurrency?: boolean;
  inheritsNamespace?: string;
  target?: string;
  enrichments?: Enrichment[];
  byFields?: ByFieldEntry[];
  fields?: FieldSummary[];
  primaryKey?: InferredPk;
  eagerWriteChildren?: ChildSpec[];
  eagerWriteChildrenByTable?: Record<string, ChildSpec[]>;
}

/** The resolved generation knobs the route render primitives read off each call. A broad bag; each language generator narrows it to its own option type. */
interface RouteGenerateOptions {
  fileFormat?: CaseFormat;
  classFormat?: CaseFormat;
  fieldFormat?: CaseFormat;
  dirFormat?: CaseFormat;
  style?: CommentStyle;
  idType?: string;
  datasourceSettings?: DatasourceSettings;
  organizeByFeature?: boolean;
  customServiceEntities?: Set<string>;
  useOptimisticConcurrency?: boolean;
  libraryReferenceMode?: string;
  language?: string;
  byFeature?: boolean;
  apiBase?: string;
}

interface RoutePrimitives {
  generateReadOnlyRouter(
    candidate: { name: string },
    options: RouteGenerateOptions,
  ): GeneratedFile;
  generateCrudRouter(
    candidate: { name: string },
    options: RouteGenerateOptions,
  ): GeneratedFile;
  generateCustomRouteStub(
    entry: RouteEntry,
    options: RouteGenerateOptions,
  ): GeneratedFile | null;
  generateNameEnrichmentHelper?(
    descriptor: { targetTable: string; fkColumn?: string; prefix?: string },
    options: RouteGenerateOptions,
  ): GeneratedFile;
  generateIndexFromFiles?(files: GeneratedFile[]): GeneratedFile[];
  generateIndexFromSchema?(
    names: string[],
    options: RouteGenerateOptions,
  ): GeneratedFile[];
  generateAppWiring?(
    wiring: {
      routers: Array<{
        name: string;
        enrichments?: unknown[];
        readOnly?: boolean;
      }>;
    },
    options: RouteGenerateOptions,
  ): GeneratedFile | null;
  nestedRouterGenerators: Record<
    string,
    (
      descriptor: NestedRouteDescriptor,
      options: RouteGenerateOptions,
    ) => GeneratedFile | null | undefined
  >;
}

type NestedRouteDescriptor = ReturnType<
  typeof collectCombinedRouteDescriptors
>[number];

interface RouteTestPrimitives {
  generateReadOnlyRouterTest(
    candidate: { name: string },
    options: RouteGenerateOptions,
  ): GeneratedFile | null;
  generateCrudRouterTest(
    candidate: { name: string },
    options: RouteGenerateOptions,
  ): GeneratedFile | null;
  generateCombinedRouteTests?(
    docs: { routesData: RoutesData; datasourceData: RawTypesDoc },
    options: RouteGenerateOptions,
  ): GeneratedFile[];
  defaultGenerateOptions?: RouteGenerateOptions;
}

type ExpandedRoutes = ReturnType<typeof expandRoutes>;

interface RouteE2ePrimitives {
  generateAppE2ETest(args: {
    datasourceData: DatasourceData;
    routesData: RoutesData;
    expanded: ExpandedRoutes;
    libraryReferenceMode: string;
    datasourceSettings: DatasourceSettings;
  }): GeneratedFile;
}

interface Overrides {
  language?: string;
  apiBase?: string;
}

interface StepInput {
  yamlText?: string;
  settings: ParsedSettings;
  overrides?: Overrides;
  deterministicDir?: string;
  routesYamlText?: string | null;
  viewYamlText?: string | null;
  datasourceYamlText?: string | null;
  datasourceSeedsYamlText?: string | null;
  servicesYamlText?: string | null;
  validLanguages?: string[];
  defaultLanguage?: string;
}

type StepGenerateConfig = Partial<RoutesGenerateConfig> & {
  overrides?: Overrides;
  organize?: string;
  expanded?: ExpandedRoutes;
};

export interface LanguageGeneratorModule {
  createGenerator(): { generate(config: StepGenerateConfig): GeneratedFile[] };
}

interface ValidationFailure {
  valid: boolean;
}

interface InvalidResult {
  invalid: ValidationFailure;
}

interface ResolvedScriptInput {
  routesData: RoutesData;
  viewData: RawTypesDoc;
  datasourceData: RawTypesDoc;
  language: string;
}

interface ResolvedTestInput extends ResolvedScriptInput {
  settings: ParsedSettings;
  overrides: Overrides;
  organize: string;
}

/** Filter route candidates to the survivors that get a router: drop no-surface + combined-children, apply the block filter, sort by name. Shared by create-routes and create-routes-tests. */
function filterRouteSurvivors(
  candidates: RouteCandidate[],
  block: { filter?: string },
  childrenOnly: Set<string>,
): RouteCandidate[] {
  const predicate = compileRoutesFilter(block.filter);
  const survivors = candidates
    .filter((c) => !hasNoRouteSurface(c))
    .filter(predicate as (c: RouteCandidate) => boolean)
    .filter((c) => !childrenOnly.has(c.name));
  survivors.sort((a, b) => a.name.localeCompare(b.name));
  return survivors;
}

/** The preamble every routes create-script shares: validate routes + view + datasource, resolve the target language. Returns `{ invalid }` or the raw validated docs + language. Callers apply their own ensureHealth / cross-validation / expansion — they differ on whether routes are health-augmented before cross-validation. */
async function resolveRoutesScriptInput(
  input: StepInput,
): Promise<InvalidResult | ResolvedScriptInput> {
  const {
    yamlText = "",
    settings,
    overrides = {},
    validLanguages,
    defaultLanguage,
  } = input;
  const { viewYamlText, datasourceYamlText, datasourceSeedsYamlText } =
    await resolveStepInputs(input, [
      "viewYamlText",
      "datasourceYamlText",
      "datasourceSeedsYamlText",
    ]);
  const vd = await validateViewAndDatasource({
    viewYamlText: viewYamlText ?? undefined,
    datasourceYamlText: datasourceYamlText ?? undefined,
    datasourceSeedsYamlText,
    context: "routes.yaml",
    idType: idTypeFromSettings(settings) as string,
  });

  const language = resolveLanguage({ language: overrides.language }, settings, {
    ...(defaultLanguage !== undefined ? { defaultLanguage } : {}),
    validLanguages,
  });
  return {
    routesData: parse(yamlText) as RoutesData,
    viewData: vd.viewData,
    datasourceData: vd.datasourceData as RawTypesDoc,
    language: language as string,
  };
}

/** Cross-validate routes against the view/datasource types. Returns `{ invalid }` on failure (for the caller's early-return) or `null` when valid. */
function crossValidateRoutesOrInvalid(
  _routesData: RoutesData,
  _viewData: RawTypesDoc,
  _datasourceData: RawTypesDoc,
): InvalidResult | null {
  return null;
}

/** `resolveRoutesScriptInput` followed by cross-validation of the raw routes — the preamble the routes *-test scripts share (they cross-validate before any ensureHealth). Returns `{ invalid }` or the validated docs + language. */
async function resolveRoutesTestInput(
  args: StepInput,
): Promise<InvalidResult | ResolvedTestInput> {
  const prep = await resolveRoutesScriptInput(args);
  if ("invalid" in prep) return prep;
  const cross = crossValidateRoutesOrInvalid(
    prep.routesData,
    prep.viewData,
    prep.datasourceData,
  );
  if (cross) return cross;
  const { settings, overrides = {} } = args;
  return {
    ...prep,
    settings,
    overrides,
    organize: organizeLayoutFromSettings(settings),
  };
}

function parsePkFieldEntry(
  entityName: string | null,
  entry: RawFieldEntry,
  i: number,
): { fieldName: string; fieldDef: RawFieldDef } {
  if (entry === null || typeof entry !== "object")
    throw new Error(
      `datasource_types[${entityName}].fields[${i}] must be a single-key field map`,
    );
  const entries = Object.entries(entry);
  if (entries.length !== 1)
    throw new Error(
      `datasource_types[${entityName}].fields[${i}] must have exactly one key`,
    );
  const [fieldName, fieldDef] = entries[0];
  if (fieldDef === null || typeof fieldDef !== "object")
    throw new Error(
      `datasource_types[${entityName}].fields[${i}].${fieldName} must be an object`,
    );
  return { fieldName, fieldDef };
}

function findCustomPrimaryKey(
  entityName: string | null,
  def: RawTypeDef | null | undefined,
): PkInfo | null {
  if (!def || typeof def !== "object") return null;
  const fields = def.fields;
  if (fields === undefined) return null;
  if (!Array.isArray(fields))
    throw new Error(`datasource_types[${entityName}].fields must be a list`);
  for (let i = 0; i < fields.length; i++) {
    const { fieldName, fieldDef } = parsePkFieldEntry(entityName, fields[i], i);
    if (fieldDef.primary_key !== true) continue;
    const fieldType =
      typeof fieldDef.type === "string" ? fieldDef.type : "integer";
    let idType = "integer";
    if (fieldType === "string") idType = "string";
    else if (fieldType === "uuid") idType = "uuid";
    return { column: fieldName, idType };
  }
  return null;
}

function extractFieldSummaries(
  rawFields: RawFieldEntry[] | undefined,
): FieldSummary[] {
  if (!Array.isArray(rawFields)) return [];
  const out: FieldSummary[] = [];
  for (const entry of rawFields) {
    if (!entry || typeof entry !== "object") continue;
    const keys = Object.keys(entry);
    if (keys.length !== 1) continue;
    const name = keys[0];
    const fdef = entry[name];
    if (!fdef || typeof fdef !== "object") continue;
    out.push({
      name,
      type: typeof fdef.type === "string" ? fdef.type : "string",
      isNullable: fdef.is_nullable === true,
    });
  }
  return out;
}

function buildCandidates(
  expandedViewData: RawTypesDoc,
  datasourceByName: Map<string, unknown>,
): RouteCandidate[] {
  return buildRouteCandidates(
    expandedViewData as Parameters<typeof buildRouteCandidates>[0],
    datasourceByName as Parameters<typeof buildRouteCandidates>[1],
    ({ parentName, parent }) => {
      const def = parent as
        | (RawTypeDef & { use_optimistic_concurrency?: boolean })
        | null
        | undefined;
      return {
        primaryKey: findCustomPrimaryKey(parentName, def),
        fields: extractFieldSummaries(def?.fields),
        optimisticConcurrency:
          def?.use_optimistic_concurrency === undefined
            ? undefined
            : def.use_optimistic_concurrency === true,
      };
    },
  ) as RouteCandidate[];
}

function upsertByField(
  list: ByFieldEntry[],
  parsed: { entity: string; byField: string; methods: string[] | null },
  datasourceByName: Map<string, unknown>,
): void {
  const existing = list.find((e) => e.byField === parsed.byField);
  if (existing) {
    if (existing.methods === undefined || parsed.methods === null)
      existing.methods = undefined;
    else if (Array.isArray(parsed.methods)) {
      const union = [...existing.methods];
      for (const m of parsed.methods) if (!union.includes(m)) union.push(m);
      existing.methods = union;
    }
    return;
  }
  const dsDef = datasourceByName.get(parsed.entity);
  const byFieldUnique = dsDef
    ? columnIsUnique(
        dsDef as Parameters<typeof columnIsUnique>[0],
        parsed.byField,
      )
    : false;
  list.push({
    byField: parsed.byField,
    methods: Array.isArray(parsed.methods) ? parsed.methods : undefined,
    byFieldUnique,
  });
}

function attachByFields(
  candidates: RouteCandidate[],
  {
    routesData,
    datasourceData,
    datasourceByName,
  }: {
    routesData: RoutesData;
    datasourceData: RawTypesDoc;
    datasourceByName: Map<string, unknown>;
  },
): void {
  const byFieldByEntity = new Map<string, ByFieldEntry[]>();
  const rawRoutes = Array.isArray(routesData.routes) ? routesData.routes : [];
  for (const entry of rawRoutes) {
    const parsed = parseByFieldEntry(
      entry,
      datasourceData as Parameters<typeof parseByFieldEntry>[1],
    );
    if (!parsed) continue;
    if (!byFieldByEntity.has(parsed.entity))
      byFieldByEntity.set(parsed.entity, []);
    upsertByField(
      byFieldByEntity.get(parsed.entity)!,
      parsed,
      datasourceByName,
    );
  }
  for (const c of candidates) {
    const list = byFieldByEntity.get(c.name);
    if (list && list.length > 0) c.byFields = list;
  }
}

function buildEntityRouters(
  candidates: RouteCandidate[],
  {
    block,
    childrenOnly,
    datasourceData,
    routesData,
    viewData,
    primitives,
    generateOptions,
  }: {
    block: { filter?: string } | null;
    childrenOnly: Set<string>;
    datasourceData: RawTypesDoc;
    routesData: RoutesData;
    viewData: RawTypesDoc;
    primitives: RoutePrimitives;
    generateOptions: RouteGenerateOptions;
  },
): GeneratedFile[] {
  if (!block) return [];
  const survivors = filterRouteSurvivors(candidates, block, childrenOnly);
  const survivorsWithPk = survivors.map((c) => ({
    ...c,
    primaryKey: inferPkForCandidate(c, datasourceData, {
      withIdType: true,
      datasourceSettings: generateOptions.datasourceSettings,
    })!,
    eagerWriteChildren: extractEagerWriteChildren(c.name, {
      datasourceData,
      routesData,
      viewData,
    }),
  }));
  const routers = survivorsWithPk.map((c) =>
    c.datasourceType === "readonly-lookup"
      ? primitives.generateReadOnlyRouter(c, generateOptions)
      : primitives.generateCrudRouter(c, generateOptions),
  );
  if (primitives.generateIndexFromSchema)
    routers.push(
      ...primitives.generateIndexFromSchema(
        survivorsWithPk.map((c) => c.name),
        generateOptions,
      ),
    );
  return routers;
}

// The app-wiring aggregator: a router per survivor wired to its generated service facade (language-optional — only lanes supplying the primitive generate a file).
function buildAppWiring(
  candidates: RouteCandidate[],
  {
    block,
    childrenOnly,
    primitives,
    generateOptions,
  }: {
    block: { filter?: string } | null;
    childrenOnly: Set<string>;
    primitives: RoutePrimitives;
    generateOptions: RouteGenerateOptions;
  },
): GeneratedFile[] {
  if (!primitives.generateAppWiring) return [];
  const survivors = block
    ? filterRouteSurvivors(candidates, block, childrenOnly)
    : [];
  const routers = survivors.map((c) => ({
    name: c.name,
    enrichments: c.enrichments ?? [],
    readOnly: c.datasourceType === "readonly-lookup",
  }));
  const file = primitives.generateAppWiring({ routers }, generateOptions);
  return file ? [file] : [];
}

function generateNameEnrichmentHelpers(
  candidates: RouteCandidate[],
  primitives: RoutePrimitives,
  generateOptions: RouteGenerateOptions,
): GeneratedFile[] {
  if (!primitives.generateNameEnrichmentHelper) return [];
  const files: GeneratedFile[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    for (const e of c.enrichments ?? []) {
      const prefix =
        typeof e.prefix === "string" && e.prefix.length > 0
          ? e.prefix
          : typeof e.fkColumn === "string" && e.fkColumn.endsWith("_id")
            ? e.fkColumn.slice(0, -"_id".length)
            : e.targetTable;
      const key = `${e.targetTable}:${prefix}`;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(
        primitives.generateNameEnrichmentHelper(
          { targetTable: e.targetTable, fkColumn: e.fkColumn, prefix },
          generateOptions,
        ),
      );
    }
  }
  return files;
}

function generateNestedRouters(
  primitives: RoutePrimitives,
  {
    routesData,
    datasourceData,
    generateOptions,
  }: {
    routesData: RoutesData;
    datasourceData: RawTypesDoc;
    generateOptions: RouteGenerateOptions;
  },
): GeneratedFile[] {
  if (Object.keys(primitives.nestedRouterGenerators).length === 0) return [];
  const files: GeneratedFile[] = [];
  const descriptors = collectCombinedRouteDescriptors({
    routesData: routesData as Parameters<
      typeof collectCombinedRouteDescriptors
    >[0]["routesData"],
    datasourceData: datasourceData as Parameters<
      typeof collectCombinedRouteDescriptors
    >[0]["datasourceData"],
  });
  const nestedOptions = { ...generateOptions, datasourceData };
  for (const d of descriptors) {
    const generateNested = primitives.nestedRouterGenerators[d.kind];
    if (!generateNested) continue;
    const file = generateNested(d, nestedOptions);
    if (file) files.push(file);
  }
  return files;
}

function buildCustomRouteStubs(
  routesData: RoutesData,
  ctx: {
    datasourceData: RawTypesDoc;
    primitives: RoutePrimitives;
    generateOptions: RouteGenerateOptions;
  },
): GeneratedFile[] {
  const { datasourceData, primitives, generateOptions } = ctx;
  return (routesData.routes ?? [])
    .filter(
      (entry) =>
        parseByFieldEntry(
          entry,
          datasourceData as Parameters<typeof parseByFieldEntry>[1],
        ) === null,
    )
    .map((entry) => primitives.generateCustomRouteStub(entry, generateOptions))
    .filter((f): f is GeneratedFile => Boolean(f));
}

function buildFiles({
  routesData,
  viewData,
  datasourceData,
  language,
  options,
  primitives,
}: {
  routesData: RoutesData;
  viewData: RawTypesDoc;
  datasourceData: RawTypesDoc;
  language: string;
  options: RouteGenerateOptions;
  primitives: RoutePrimitives;
}): { generated: GeneratedFile[]; custom: GeneratedFile[] } {
  const block = routeViewTypeDirective(routesData) as
    | (RouteViewTypeDirective & { filter?: string })
    | null;
  const generated: GeneratedFile[] = [];
  const byFeature = options.organizeByFeature === true;
  const generateOptions = { ...options, language, byFeature };
  const datasourceByName = indexDatasourceByName(datasourceData);
  const expanded = expandViewTypes(viewData, datasourceData);
  const candidates = buildCandidates(expanded, datasourceByName);
  const childrenOnly = collectCombinedChildNames(
    routesData as Parameters<typeof collectCombinedChildNames>[0],
    datasourceByName as Parameters<typeof collectCombinedChildNames>[1],
  );
  attachByFields(candidates, { routesData, datasourceData, datasourceByName });
  const routerCtx = {
    block,
    childrenOnly,
    datasourceData,
    routesData,
    viewData,
    primitives,
    generateOptions,
  };
  generated.push(...buildEntityRouters(candidates, routerCtx));
  generated.push(...buildAppWiring(candidates, routerCtx));
  const custom = buildCustomRouteStubs(routesData, {
    datasourceData,
    primitives,
    generateOptions,
  });
  generated.push(
    ...generateNameEnrichmentHelpers(candidates, primitives, generateOptions),
  );
  generated.push(
    ...generateNestedRouters(primitives, {
      routesData,
      datasourceData,
      generateOptions,
    }),
  );
  return { generated, custom };
}

function buildRouteFiles({
  routesData,
  viewData,
  datasourceData,
  servicesData,
  language,
  settings,
  primitives,
}: {
  routesData: RoutesData;
  viewData: RawTypesDoc;
  datasourceData: RawTypesDoc;
  servicesData: ServicesData | null;
  language: string;
  settings: ParsedSettings;
  primitives: RoutePrimitives;
}): GeneratedFile[] {
  const customServiceEntities = servicesData
    ? customServiceEntitySet(servicesData)
    : new Set<string>();
  const ds = datasourceSettingsForSettings(settings);
  const { generated, custom } = buildFiles({
    routesData,
    viewData,
    datasourceData,
    language,
    primitives,
    options: {
      ...caseOptionsFromSettings(settings, String(language).toLowerCase()),
      style: (settings.commentStyle ?? DEFAULT_COMMENT_STYLE) as CommentStyle,
      idType: ds.idType,
      datasourceSettings: ds,
      organizeByFeature: settings.other.organizeByFeature === true,
      customServiceEntities,
      useOptimisticConcurrency: ds.useOptimisticConcurrency,
      libraryReferenceMode: resolveLibraryReferenceMode(
        settings.languages,
        String(language).toLowerCase(),
      ),
    },
  });
  const createIndex = settings.codegen.createIndex ?? true;
  const byFeature = settings.other.organizeByFeature === true;
  let indexFiles: GeneratedFile[] = [];
  if (createIndex && !byFeature && primitives.generateIndexFromFiles)
    indexFiles = primitives.generateIndexFromFiles([...generated, ...custom]);
  return [
    ...generated.map((f) => ({ ...f, kind: "generated" })),
    ...custom.map((f) => ({ ...f, kind: "custom" })),
    ...indexFiles.map((f) => ({ ...f, kind: "index" })),
  ];
}

interface GenerateRoutesFilesInput extends RoutesGenerateConfig {
  primitives: RoutePrimitives;
}

/** The full routes generate: owns options/layout, runs the shared orchestration with a dialect's route primitives. */
export function generateRoutesFiles(input: GenerateRoutesFilesInput): GeneratedFile[] {
  const {
    routes,
    viewTypes,
    datasourceTypes,
    services,
    settings,
    language,
    primitives,
  } = input;
  return buildRouteFiles({
    routesData: routes as RoutesData,
    viewData: viewTypes as RawTypesDoc,
    datasourceData: datasourceTypes as RawTypesDoc,
    servicesData: services as ServicesData | null,
    language: language as string,
    settings,
    primitives,
  });
}

/** Shared routes step: validate routes + view + datasource (+ optional services), cross-validate, dispatch. */
export function dispatchRoutesStep(generator: LanguageGeneratorModule) {
  const validLanguages = SUPPORTED_LANGUAGES as string[];
  return async function generate(input: StepInput) {
    const prep = await resolveRoutesScriptInput({ ...input, validLanguages });
    if ("invalid" in prep) return emptyGenerateResult(prep.invalid);
    const { servicesYamlText } = await resolveStepInputs(input, [
      "servicesYamlText",
    ]);
    const { settings } = input;
    let servicesData: ServicesData | null = null;
    if (servicesYamlText) {
      servicesData = ensureHealthServiceFirst(parse(servicesYamlText))
        .doc as ServicesData;
    }
    const { viewData, datasourceData, language } = prep;
    const routesData = ensureHealthRouteFirst(prep.routesData)
      .doc as RoutesData;
    const cross = crossValidateRoutesOrInvalid(
      routesData,
      viewData,
      datasourceData,
    );
    if (cross) return emptyGenerateResult(cross.invalid);
    const files = generator.createGenerator().generate({
      language,
      routes: routesData,
      viewTypes: viewData,
      datasourceTypes: datasourceData,
      services: servicesData,
      settings,
    });
    return {
      files,
      language,
      organize: organizeLayoutFromSettings(settings),
      validation: { valid: true },
    };
  };
}

function buildRouteTestCandidates(
  expandedViewData: RawTypesDoc,
  datasourceByName: Map<string, unknown>,
  {
    datasourceData,
    datasourceSettings,
  }: { datasourceData: RawTypesDoc; datasourceSettings?: DatasourceSettings },
): RouteCandidate[] {
  return buildRouteCandidates(
    expandedViewData as Parameters<typeof buildRouteCandidates>[0],
    datasourceByName as Parameters<typeof buildRouteCandidates>[1],
    ({ parentName, parent }) => {
      const def = parent as
        | { use_optimistic_concurrency?: boolean }
        | null
        | undefined;
      return {
        primaryKey: parentName
          ? inferPkForCandidate({ name: parentName }, datasourceData, {
              withIdType: true,
              datasourceSettings,
            })
          : null,
        optimisticConcurrency:
          def?.use_optimistic_concurrency === undefined
            ? undefined
            : def.use_optimistic_concurrency === true,
      };
    },
  ) as RouteCandidate[];
}

function attachRouteTestByFields(
  candidates: RouteCandidate[],
  routesData: RoutesData,
  datasourceByName: Map<string, unknown>,
): void {
  const byFieldByEntity = new Map<string, ByFieldEntry[]>();
  for (const entry of routesData.routes ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const def = Object.values(entry)[0];
    if (!def || typeof def !== "object") continue;
    if (typeof def.entity !== "string" || typeof def.byField !== "string")
      continue;
    if (!byFieldByEntity.has(def.entity)) byFieldByEntity.set(def.entity, []);
    const dsDef = datasourceByName.get(def.entity);
    const byFieldUnique = dsDef
      ? columnIsUnique(
          dsDef as Parameters<typeof columnIsUnique>[0],
          def.byField,
        )
      : false;
    byFieldByEntity.get(def.entity)!.push({
      byField: def.byField,
      methods: Array.isArray(def.methods) ? def.methods : undefined,
      byFieldUnique,
    });
  }
  for (const c of candidates) {
    const list = byFieldByEntity.get(c.name);
    if (list && list.length > 0) c.byFields = list;
  }
}

function generateRouterTestFiles(
  candidates: RouteCandidate[],
  ctx: {
    block: (RouteViewTypeDirective & { filter?: string }) | null;
    childrenOnly: Set<string>;
    routesData: RoutesData;
    datasourceData: RawTypesDoc;
    viewData: RawTypesDoc;
    primitives: RouteTestPrimitives;
    generateOptions: RouteGenerateOptions;
  },
): GeneratedFile[] {
  const { block, childrenOnly, routesData, datasourceData, viewData } = ctx;
  const { primitives, generateOptions } = ctx;
  if (!block) return [];
  const survivors = filterRouteSurvivors(candidates, block, childrenOnly);
  const survivorsWithChildren = survivors.map((c) => ({
    ...c,
    eagerWriteChildren: extractEagerWriteChildren(c.name, {
      datasourceData,
      routesData,
      viewData,
    }),
    eagerWriteChildrenByTable: buildEagerWriteChildrenClosure(c.name, {
      datasourceData,
      routesData,
      viewData,
    }),
  }));
  const files: GeneratedFile[] = [];
  for (const c of survivorsWithChildren) {
    const file =
      c.datasourceType === "readonly-lookup"
        ? primitives.generateReadOnlyRouterTest(c, generateOptions)
        : primitives.generateCrudRouterTest(c, generateOptions);
    if (file) files.push(file);
  }
  return files;
}

function buildRouteTestFiles({
  routesData,
  viewData,
  datasourceData,
  primitives,
  generateOptions,
}: {
  routesData: RoutesData;
  viewData: RawTypesDoc;
  datasourceData: RawTypesDoc;
  primitives: RouteTestPrimitives;
  generateOptions: RouteGenerateOptions;
}): GeneratedFile[] {
  const block = routeViewTypeDirective(routesData) as
    | (RouteViewTypeDirective & { filter?: string })
    | null;
  const files: GeneratedFile[] = [];
  const datasourceByName = indexDatasourceByName(datasourceData);
  const expanded = expandViewTypes(viewData, datasourceData);
  const candidates = buildRouteTestCandidates(expanded, datasourceByName, {
    datasourceData,
    datasourceSettings: generateOptions.datasourceSettings,
  });
  const childrenOnly = collectCombinedChildNames(
    routesData as Parameters<typeof collectCombinedChildNames>[0],
    datasourceByName as Parameters<typeof collectCombinedChildNames>[1],
  );
  attachRouteTestByFields(candidates, routesData, datasourceByName);
  files.push(
    ...generateRouterTestFiles(candidates, {
      block,
      childrenOnly,
      routesData,
      datasourceData,
      viewData,
      primitives,
      generateOptions,
    }),
  );
  if (primitives.generateCombinedRouteTests) {
    files.push(
      ...primitives.generateCombinedRouteTests(
        { routesData, datasourceData },
        generateOptions,
      ),
    );
  }
  return files;
}

interface GenerateRoutesTestsFilesInput extends RoutesGenerateConfig {
  overrides?: Overrides;
  primitives: RouteTestPrimitives;
}

export function generateRoutesTestsFiles(
  input: GenerateRoutesTestsFilesInput,
): GeneratedFile[] {
  const {
    routes,
    viewTypes,
    datasourceTypes,
    settings,
    overrides = {},
    language,
    primitives,
  } = input;
  const ds = datasourceSettingsForSettings(settings);
  const generateOptions: RouteGenerateOptions = {
    ...(primitives.defaultGenerateOptions ?? {}),
    ...(overrides.apiBase !== undefined ? { apiBase: overrides.apiBase } : {}),
    language: language as string,
    ...caseOptionsFromSettings(settings, String(language).toLowerCase()),
    idType: ds.idType,
    datasourceSettings: ds,
    organizeByFeature: settings.other.organizeByFeature === true,
    useOptimisticConcurrency: ds.useOptimisticConcurrency,
  };
  return buildRouteTestFiles({
    routesData: routes as RoutesData,
    viewData: viewTypes as RawTypesDoc,
    datasourceData: datasourceTypes as RawTypesDoc,
    primitives,
    generateOptions,
  });
}

export function dispatchRoutesTestsStep(generator: LanguageGeneratorModule) {
  const validLanguages = SUPPORTED_LANGUAGES as string[];
  return async function generate(input: StepInput) {
    const prep = await resolveRoutesTestInput({ ...input, validLanguages });
    if ("invalid" in prep) return emptyGenerateResult(prep.invalid);
    const {
      routesData,
      viewData,
      datasourceData,
      language,
      settings,
      overrides,
      organize,
    } = prep;
    const files = generator.createGenerator().generate({
      routes: routesData,
      viewTypes: viewData,
      datasourceTypes: datasourceData,
      settings,
      overrides,
      organize,
      language,
    });
    return { files, language, organize, validation: { valid: true } };
  };
}

interface GenerateRouteE2eFilesInput extends RoutesGenerateConfig {
  primitives: RouteE2ePrimitives;
}

export function generateRouteE2eFiles(
  input: GenerateRouteE2eFilesInput,
): GeneratedFile[] {
  const { routes, datasourceTypes, settings, language, primitives } = input;
  const expanded = (input as { expanded?: ExpandedRoutes }).expanded;
  const libraryReferenceMode = resolveLibraryReferenceMode(
    settings.languages,
    language as string,
  );
  return [
    primitives.generateAppE2ETest({
      datasourceData: datasourceTypes as DatasourceData,
      routesData: routes as RoutesData,
      expanded: expanded!,
      libraryReferenceMode,
      datasourceSettings: datasourceSettingsForSettings(settings),
    }),
  ];
}

export function dispatchRouteE2eStep(generator: LanguageGeneratorModule) {
  const validLanguages = SUPPORTED_LANGUAGES as string[];
  return async function generate(input: StepInput) {
    const prep = await resolveRoutesTestInput({
      ...input,
      validLanguages,
      defaultLanguage: DEFAULT_LANGUAGE,
    });
    if ("invalid" in prep) return emptyGenerateResult(prep.invalid);
    const { routesData, viewData, datasourceData, language, settings } = prep;
    let expanded: ExpandedRoutes;
    try {
      expanded = expandRoutes({
        routesData: routesData as Parameters<
          typeof expandRoutes
        >[0]["routesData"],
        viewData,
        datasourceData,
      });
    } catch (e) {
      const err = e as Error;
      return emptyGenerateResult({
        valid: false,
        errors: [{ line: 0, col: 0, message: err.message }],
      });
    }
    const files = generator.createGenerator().generate({
      routes: routesData,
      viewTypes: viewData,
      datasourceTypes: datasourceData,
      expanded,
      settings,
      language,
    });
    return {
      files,
      language,
      organize: "by-business-concern",
      validation: { valid: true },
    };
  };
}

interface RoutesStepConfig {
  dispatchStep: (
    generator: LanguageGeneratorModule,
  ) => (input: StepInput) => unknown;
  generator: LanguageGeneratorModule;
  language: string;
}

/** Catalog `{ inputs, settings }` adapter for the routes family: the step's own YAML is `routes.yaml`. Thin over the shared `catalogStepGenerate`. */
export const routesStepGenerate = <TCtx>(config: RoutesStepConfig, ctx: TCtx) =>
  catalogStepGenerate(
    { ...config, primary: "routesYamlText" },
    ctx as Parameters<typeof catalogStepGenerate>[1],
  );

/** Kebab-cased entity name of every explicit custom service in services.yaml, used to give route → custom-service imports a `custom/` path segment. */
function customServiceEntitySet(servicesDoc: ServicesData | null): Set<string> {
  const out = new Set<string>();
  if (!servicesDoc || typeof servicesDoc !== "object") return out;
  const services = Array.isArray(servicesDoc.services)
    ? servicesDoc.services
    : [];
  for (const entry of services) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.name !== "string" || entry.name.length === 0) continue;
    const derived = ImportPaths.featureEntity(entry.name);
    if (derived) out.add(derived);
  }
  return out;
}
