import { parse } from "yaml";
import { resolveLanguage } from "./resolve-language.ts";
import { validateViewAndDatasource } from "./script-input.ts";
import {
  idTypeFromSettings,
  datasourceSettingsForSettings,
} from "./ts-datasource-settings.ts";
import { resolveStepInputs } from "./deterministic-inputs.ts";
import { emptyGenerateResult } from "./generate-result.ts";
import { catalogStepGenerate } from "./catalog-step-generate.ts";
import {
  serviceCandidateSurvivors,
  serviceViewTypeDirective,
  buildCandidates,
  compileServicesFilter,
} from "../../lib/services-expand.ts";
import { expandViewTypes } from "../../view-expand.ts";
import { SUPPORTED_LANGUAGES } from "../../read-settings.ts";
import {
  ensureHealthServiceFirst,
  ensureHealthRouteFirst,
} from "./seed-healthcheck-yaml.ts";
import { buildEnrichedOpenApiSpec } from "./openapi-spec-build.ts";
import { sampleFromSchema } from "./schema-sample.ts";
import { inferPkForCandidate } from "./infer-pk-for-candidate.ts";
import { byFieldsWithTypesFromDatasource } from "../../lib/datasource-by-fields.ts";
import {
  organizeLayoutFromSettings,
  configKnobsFromSettings,
} from "./generate-settings-options.ts";
import { caseOptionsFromSettings, namesFor } from "./ts-codegen-naming.ts";
import {
  extractEagerWriteChildren,
  buildEagerWriteChildrenClosure,
} from "./eager-write-children.ts";
import type {
  ParsedSettings,
  JsonValue,
} from "../../read-settings.ts";
import type {
  RawTypesDoc,
  RawIncludeEntry,
} from "../../deterministic-shapes.ts";
import type { CaseFormat } from "../../case.ts";
import type { CommentStyle } from "../../generate-doc-comment.ts";
import type { DatasourceSettings } from "../../datasource-settings.ts";
import type { ServicesDoc } from "../../lib/services-expand.ts";
import type {
  GeneratedFile,
  ServiceTestsGenerateConfig,
} from "./service-tests-generate-types.ts";

interface ServiceEntryDef {
  name: string;
  module?: string;
}

interface ServicesData extends ServicesDoc {
  services: ServiceEntryDef[];
}

interface ServicesRoutesData {
  routes?: RawIncludeEntry[];
  combined_routes?: RawIncludeEntry[];
}

interface RouteServiceEntry {
  service: string;
  serviceMethod: string;
  response?: string;
}

type ChildSpec = ReturnType<typeof extractEagerWriteChildren>[number];
type RawServiceCandidate = ReturnType<typeof serviceCandidateSurvivors>[number];
type InferredPk = NonNullable<ReturnType<typeof inferPkForCandidate>>;

interface ServiceCandidate extends Omit<RawServiceCandidate, "datasourceType"> {
  datasourceType?: string;
}

interface ServiceByField {
  field: string;
  type: string;
  size?: number;
}

interface GenericServiceCandidate extends ServiceCandidate {
  primaryKey: InferredPk;
  eagerWriteChildren?: ChildSpec[];
  byFields?: ServiceByField[];
}

interface ServiceTestCandidate extends ServiceCandidate {
  primaryKey: InferredPk & { idType: string };
  eagerWriteChildren?: ChildSpec[];
  eagerWriteChildrenByTable?: Record<string, ChildSpec[]>;
}

/** The resolved generation knobs the service render primitives read off each call — a broad bag each language generator narrows to its own option type. */
interface ServiceGenerateOptions {
  language?: string;
  fileFormat?: CaseFormat;
  classFormat?: CaseFormat;
  fieldFormat?: CaseFormat;
  dirFormat?: CaseFormat;
  organizeByFeature?: boolean;
  byFeature?: boolean;
  style?: CommentStyle;
  libraryReferenceMode?: string;
  idType?: string;
  datetime?: string;
  pluralizeTableNames?: boolean;
  createIndex?: boolean;
  schemaVersion?: string;
  datasourceSettings?: DatasourceSettings;
  methods?: string[];
  responseSamples?: Map<string, JsonValue>;
  datasource?: RawTypesDoc;
}

/** The per-language `DEFAULT_GENERATE_OPTIONS` bag each primitive carries — spread into the resolved options; its varied fields differ by dialect, so it is typed permissively. */
interface DefaultGenerateOptions {
  createIndex?: boolean;
  fileFormat?: string;
  style?: CommentStyle;
  schemaVersion?: string;
  servicePath?: string | null;
  packageName?: string;
  datetime?: string;
}

interface ServicePrimitives {
  generateGenericService(
    candidate: GenericServiceCandidate,
    options: ServiceGenerateOptions,
  ): GeneratedFile | null;
  generateCustomServiceStub(
    entry: ServiceEntryDef,
    options: ServiceGenerateOptions,
  ): GeneratedFile;
  generateIndexFromSchema?(
    genericEntities: string[],
    customEntries: ServiceEntryDef[],
    options: ServiceGenerateOptions,
  ): GeneratedFile[];
  defaultGenerateOptions?: DefaultGenerateOptions;
}

interface ServiceTestPrimitives {
  generateGenericServiceTest(
    candidate: ServiceTestCandidate,
    options: ServiceGenerateOptions,
  ): GeneratedFile | null;
  defaultGenerateOptions?: DefaultGenerateOptions;
}

interface ServiceIntegrationPrimitives {
  generateGenericServiceIntegrationTest(
    candidate: ServiceCandidate,
    options: ServiceGenerateOptions,
  ): GeneratedFile | null;
  defaultGenerateOptions?: DefaultGenerateOptions;
}

interface Overrides {
  language?: string;
}

interface StepInput {
  yamlText?: string;
  settings: ParsedSettings;
  overrides?: Overrides;
  deterministicDir?: string;
  routesYamlText?: string | null;
  viewYamlText?: string | null;
  datasourceYamlText?: string | null;
  servicesYamlText?: string | null;
}

interface ResolvedServicesInput {
  servicesData: ServicesData;
  viewData: RawTypesDoc;
  datasourceData: RawTypesDoc;
  routesData: ServicesRoutesData | null;
  language: string;
}

interface ValidationFailure {
  valid: boolean;
}

interface InvalidResult {
  invalid: ValidationFailure;
}

type StepGenerateConfig = Partial<ServiceTestsGenerateConfig>;

interface LanguageGeneratorModule {
  createGenerator(): { generate(config: StepGenerateConfig): GeneratedFile[] };
}

type DispatchExtra = { customServiceNames: string[] };

/** The preamble every services create-script shares: validate services + view + datasource (+ optional routes), resolve the target language. */
async function resolveServicesScriptInput({
  yamlText = "",
  viewYamlText,
  datasourceYamlText,
  datasourceSeedsYamlText,
  routesYamlText = null,
  settings,
  overrides = {},
}: {
  yamlText?: string;
  viewYamlText?: string | null;
  datasourceYamlText?: string | null;
  datasourceSeedsYamlText?: string | null;
  routesYamlText?: string | null;
  settings: ParsedSettings;
  overrides?: Overrides;
  validLanguages?: string[];
}): Promise<InvalidResult | ResolvedServicesInput> {
  const vd = await validateViewAndDatasource({
    viewYamlText: viewYamlText ?? undefined,
    datasourceYamlText: datasourceYamlText ?? undefined,
    datasourceSeedsYamlText,
    context: "services.yaml",
    idType: idTypeFromSettings(settings) as string,
  });
  let routesData: ServicesRoutesData | null = null;
  if (routesYamlText) {
    routesData = parse(routesYamlText) as ServicesRoutesData;
  }
  const language = resolveLanguage({ language: overrides.language }, settings, {
    validLanguages: SUPPORTED_LANGUAGES as string[],
  });
  return {
    servicesData: parse(yamlText) as ServicesData,
    viewData: vd.viewData,
    datasourceData: vd.datasourceData as RawTypesDoc,
    routesData,
    language: language as string,
  };
}

function buildOneGenericService(
  cand: ServiceCandidate,
  {
    explicitNames,
    datasourceData,
    routesData,
    viewData,
    byFieldsByEntity,
    primitives,
    generateOptions,
  }: {
    explicitNames: Set<string>;
    datasourceData: RawTypesDoc;
    routesData: ServicesRoutesData | null;
    viewData: RawTypesDoc;
    byFieldsByEntity: ReturnType<typeof byFieldsWithTypesFromDatasource>;
    primitives: ServicePrimitives;
    generateOptions: ServiceGenerateOptions;
  },
): { file: GeneratedFile; name: string } | null {
  const className = namesFor(generateOptions).className(cand.name, "service");
  if (explicitNames.has(className)) return null;
  const enriched: GenericServiceCandidate = {
    ...cand,
    primaryKey: inferPkForCandidate(cand, datasourceData)!,
    eagerWriteChildren: extractEagerWriteChildren(cand.name, {
      datasourceData,
      routesData,
      viewData,
    }),
    byFields: (byFieldsByEntity.get(cand.name) ?? []) as ServiceByField[],
  };
  const file = primitives.generateGenericService(enriched, generateOptions);
  return file === null ? null : { file, name: cand.name };
}

function buildGenericFiles({
  servicesData,
  viewData,
  datasourceData,
  routesData,
  primitives,
  generateOptions,
}: {
  servicesData: ServicesData;
  viewData: RawTypesDoc;
  datasourceData: RawTypesDoc;
  routesData: ServicesRoutesData | null;
  primitives: ServicePrimitives;
  generateOptions: ServiceGenerateOptions;
}): { files: GeneratedFile[]; entityNames: string[] } {
  const block = serviceViewTypeDirective(servicesData);
  if (!block) return { files: [], entityNames: [] };
  const explicitNames = customServiceNames(servicesData);
  const survivors = serviceCandidateSurvivors({
    block,
    viewData,
    datasourceData,
    expandOptions: { mode: "service" },
  }) as ServiceCandidate[];
  const byFieldsByEntity = byFieldsWithTypesFromDatasource(datasourceData);
  const files: GeneratedFile[] = [];
  const entityNames: string[] = [];
  for (const cand of survivors) {
    const built = buildOneGenericService(cand, {
      explicitNames,
      datasourceData,
      routesData,
      viewData,
      byFieldsByEntity,
      primitives,
      generateOptions,
    });
    if (!built) continue;
    files.push(built.file);
    entityNames.push(built.name);
  }
  return { files, entityNames };
}

function isRouteServiceEntry(
  entry: RawIncludeEntry,
): entry is RawIncludeEntry & RouteServiceEntry {
  return (
    typeof entry.service === "string" && typeof entry.serviceMethod === "string"
  );
}

function walkRouteServiceEntries(
  routesData: ServicesRoutesData,
  visitEntry: (entry: RouteServiceEntry) => void,
): void {
  const visit = (entry: RawIncludeEntry) => {
    if (!entry || typeof entry !== "object") return;
    if (isRouteServiceEntry(entry)) {
      visitEntry(entry);
    }
    for (const v of Object.values(entry)) {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object") visit(v as RawIncludeEntry);
    }
  };
  for (const arr of [routesData.routes, routesData.combined_routes]) {
    if (Array.isArray(arr)) arr.forEach(visit);
  }
}

function collectRouteServiceMethods(
  routesData: ServicesRoutesData | null,
): Map<string, Set<string>> {
  const byService = new Map<string, Set<string>>();
  if (!routesData) return byService;
  walkRouteServiceEntries(routesData, (entry) => {
    if (!byService.has(entry.service)) byService.set(entry.service, new Set());
    byService.get(entry.service)!.add(entry.serviceMethod);
  });
  return byService;
}

function collectRouteServiceResponseTypes(
  routesData: ServicesRoutesData | null,
): Map<string, Map<string, string>> {
  const byService = new Map<string, Map<string, string>>();
  if (!routesData) return byService;
  walkRouteServiceEntries(routesData, (entry) => {
    if (typeof entry.response !== "string") return;
    if (!byService.has(entry.service)) byService.set(entry.service, new Map());
    byService.get(entry.service)!.set(entry.serviceMethod, entry.response);
  });
  return byService;
}

function buildResponseSamplesByServiceMethod({
  routesData,
  viewData,
  datasourceData,
}: {
  routesData: ServicesRoutesData | null;
  viewData: RawTypesDoc;
  datasourceData: RawTypesDoc;
}): Map<string, Map<string, JsonValue>> {
  const out = new Map<string, Map<string, JsonValue>>();
  if (!routesData) return out;
  const responseTypesByService = collectRouteServiceResponseTypes(routesData);
  if (responseTypesByService.size === 0) return out;
  const doc = buildEnrichedOpenApiSpec({
    routesData: routesData as Parameters<
      typeof buildEnrichedOpenApiSpec
    >[0]["routesData"],
    viewData,
    datasourceData,
  });
  const schemas = doc.components!.schemas;
  for (const [service, methods] of responseTypesByService) {
    const innerOut = new Map<string, JsonValue>();
    for (const [method, responseName] of methods) {
      const schema = schemas[responseName];
      if (!schema) continue;
      const sample = sampleFromSchema(
        schema as Parameters<typeof sampleFromSchema>[0],
        doc as Parameters<typeof sampleFromSchema>[1],
        0,
      ) as JsonValue;
      if (sample !== undefined && sample !== null) innerOut.set(method, sample);
    }
    if (innerOut.size > 0) out.set(service, innerOut);
  }
  return out;
}

/** A services.yaml entry whose module targets ./services/generated/ is a standard-CRUD service backed by a datasource_types entity — the entity generator generates it as full CRUD (IStandardCrudService), so it neither suppresses that generic service nor receives a custom stub. Real custom services point at ./services/custom/ or ./features/. */
function isStandardCrudEntry(entry: ServiceEntryDef): boolean {
  return (
    typeof entry.module === "string" &&
    entry.module.startsWith("./services/generated/")
  );
}

/** Names of the genuinely-custom services (a standard-CRUD entry backed by a datasource_types entity, declared with a ./services/generated/ module, is NOT custom) — the entity generator owns those, so they neither suppress the generic service nor get a stub. */
function customServiceNames(servicesData: ServicesData): Set<string> {
  return new Set(
    servicesData.services
      .filter((s) => !isStandardCrudEntry(s))
      .map((s) => s.name),
  );
}

function buildCustomFiles({
  servicesData,
  primitives,
  generateOptions,
  methodsByService,
  responseSamplesByServiceMethod,
}: {
  servicesData: ServicesData;
  primitives: ServicePrimitives;
  generateOptions: ServiceGenerateOptions;
  methodsByService: Map<string, Set<string>>;
  responseSamplesByServiceMethod: Map<string, Map<string, JsonValue>>;
}): GeneratedFile[] {
  return servicesData.services
    .filter((entry) => !isStandardCrudEntry(entry))
    .map((entry) => {
      const methods = methodsByService.get(entry.name);
      const responseSamples = responseSamplesByServiceMethod.get(entry.name);
      const stubOpts: ServiceGenerateOptions = methods
        ? { ...generateOptions, methods: [...methods].sort(), responseSamples }
        : generateOptions;
      return primitives.generateCustomServiceStub(entry, stubOpts);
    });
}

function resolveServicesGenerateOptions(
  defaultGenerateOptions: DefaultGenerateOptions | undefined,
  settings: ParsedSettings,
  language: string,
): ServiceGenerateOptions {
  return {
    ...defaultGenerateOptions,
    ...caseOptionsFromSettings(settings, language),
    ...configKnobsFromSettings(settings, language),
    language,
  } as ServiceGenerateOptions;
}

function buildServiceFiles({
  servicesData,
  viewData,
  datasourceData,
  routesData,
  primitives,
  generateOptions,
  createIndex,
}: {
  servicesData: ServicesData;
  viewData: RawTypesDoc;
  datasourceData: RawTypesDoc;
  routesData: ServicesRoutesData | null;
  primitives: ServicePrimitives;
  generateOptions: ServiceGenerateOptions;
  createIndex: boolean;
}): GeneratedFile[] {
  const methodsByService = collectRouteServiceMethods(routesData);
  const responseSamplesByServiceMethod = buildResponseSamplesByServiceMethod({
    routesData,
    viewData,
    datasourceData,
  });
  const byFeature = generateOptions.organizeByFeature === true;
  const { files: genericFiles, entityNames } = buildGenericFiles({
    servicesData,
    viewData,
    datasourceData,
    routesData,
    primitives,
    generateOptions: { ...generateOptions, organizeByFeature: byFeature },
  });
  const customFiles = buildCustomFiles({
    servicesData,
    primitives,
    generateOptions: { ...generateOptions, byFeature },
    methodsByService,
    responseSamplesByServiceMethod,
  });
  let indexFiles: GeneratedFile[] = [];
  if (createIndex && !byFeature && primitives.generateIndexFromSchema) {
    indexFiles = primitives.generateIndexFromSchema(
      entityNames,
      servicesData.services,
      generateOptions,
    );
  }
  return [
    ...genericFiles.map((f) => ({ ...f, kind: "generic" })),
    ...customFiles.map((f) => ({ ...f, kind: "custom" })),
    ...indexFiles.map((f) => ({ ...f, kind: "index" })),
  ];
}

interface GenerateServicesFilesInput extends ServiceTestsGenerateConfig {
  primitives: ServicePrimitives;
}

/** The full services generate: owns options + layout, runs the shared orchestration with a dialect's render primitives. */
export function generateServicesFiles(
  input: GenerateServicesFilesInput,
): GeneratedFile[] {
  const {
    services,
    viewTypes,
    datasourceTypes,
    routes,
    settings,
    language,
    primitives,
  } = input;
  const servicesData = ensureHealthServiceFirst(services).doc as ServicesData;
  const routesData = routes
    ? (ensureHealthRouteFirst(routes).doc as ServicesRoutesData)
    : null;
  const generateOptions = resolveServicesGenerateOptions(
    primitives.defaultGenerateOptions,
    settings,
    language as string,
  );
  return buildServiceFiles({
    servicesData,
    viewData: viewTypes as RawTypesDoc,
    datasourceData: datasourceTypes as RawTypesDoc,
    routesData,
    primitives,
    generateOptions,
    createIndex: settings.codegen.createIndex ?? true,
  });
}

/** Shared step body for every services dispatcher: prep + language guard, run the language generator, wrap the result. `withRoutes` threads `routes` into the generate config; `resultExtra(prep)` and `invalidExtra` add the per-step tail fields. */
async function runServicesDispatch(
  generator: LanguageGeneratorModule,
  input: StepInput,
  {
    withRoutes = false,
    resultExtra,
    invalidExtra,
  }: {
    validLanguages?: string[];
    withRoutes?: boolean;
    resultExtra?: (prep: ResolvedServicesInput) => DispatchExtra;
    invalidExtra?: DispatchExtra;
  } = {},
) {
  const extras = await resolveStepInputs(
    input,
    withRoutes
      ? [
          "viewYamlText",
          "datasourceYamlText",
          "datasourceSeedsYamlText",
          "routesYamlText",
        ]
      : ["viewYamlText", "datasourceYamlText", "datasourceSeedsYamlText"],
  );
  return resolveServicesScriptInput({
    ...input,
    ...extras,
  }).then((prep) => {
    if ("invalid" in prep)
      return { ...emptyGenerateResult(prep.invalid), ...invalidExtra };
    const { servicesData, viewData, datasourceData, routesData, language } =
      prep;
    const files = generator.createGenerator().generate({
      language,
      services: servicesData,
      viewTypes: viewData,
      datasourceTypes: datasourceData,
      ...(withRoutes ? { routes: routesData } : {}),
      settings: input.settings,
    });
    return {
      files,
      language,
      organize: organizeLayoutFromSettings(input.settings),
      validation: { valid: true },
      ...(resultExtra ? resultExtra(prep) : {}),
    };
  });
}

/** Shared services step generate: validate + resolve language, dispatch to the language's services generator. */
export function dispatchServicesStep(generator: LanguageGeneratorModule) {
  return (input: StepInput) =>
    runServicesDispatch(generator, input, {
      validLanguages: SUPPORTED_LANGUAGES as string[],
      withRoutes: true,
    });
}

function kebabOfServiceName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

/** Generate one file per survivor whose derived service class isn't an explicit custom service — the shared skeleton behind the generic-test and integration-test loops. `generateOne` returns the file (or null to skip). */
function generateSurvivorFiles<T extends { name: string }>(
  survivors: T[],
  opts: { explicitNames: Set<string>; generateOptions: ServiceGenerateOptions },
  generateOne: (cand: T) => GeneratedFile | null,
): GeneratedFile[] {
  const { explicitNames, generateOptions } = opts;
  const names = namesFor(generateOptions);
  const files: GeneratedFile[] = [];
  for (const cand of survivors) {
    const className = names.className(cand.name, "service");
    if (explicitNames.has(className)) continue;
    const file = generateOne(cand);
    if (file !== null) files.push(file);
  }
  return files;
}

function buildGenericTestFiles({
  servicesData,
  viewData,
  datasourceData,
  routesData,
  primitives,
  generateOptions,
}: {
  servicesData: ServicesData;
  viewData: RawTypesDoc;
  datasourceData: RawTypesDoc;
  routesData: ServicesRoutesData | null;
  primitives: ServiceTestPrimitives;
  generateOptions: ServiceGenerateOptions;
}): GeneratedFile[] {
  const block = serviceViewTypeDirective(servicesData);
  if (!block) return [];
  const explicitNames = customServiceNames(servicesData);
  const survivors = serviceCandidateSurvivors({
    block,
    viewData,
    datasourceData,
    expandOptions: { mode: "service" },
  }) as ServiceCandidate[];
  return generateSurvivorFiles(
    survivors,
    { explicitNames, generateOptions },
    (cand) => {
      const withPk: ServiceTestCandidate = {
        ...cand,
        primaryKey: inferPkForCandidate(cand, datasourceData, {
          withIdType: true,
          datasourceSettings: generateOptions.datasourceSettings,
        })! as InferredPk & { idType: string },
      };
      const enriched: ServiceTestCandidate = routesData
        ? {
            ...withPk,
            eagerWriteChildren: extractEagerWriteChildren(cand.name, {
              datasourceData,
              routesData,
              viewData,
            }),
            eagerWriteChildrenByTable: buildEagerWriteChildrenClosure(
              cand.name,
              {
                datasourceData,
                routesData,
                viewData,
              },
            ),
          }
        : withPk;
      return primitives.generateGenericServiceTest(enriched, generateOptions);
    },
  );
}

interface GenerateServiceTestsFilesInput extends ServiceTestsGenerateConfig {
  primitives: ServiceTestPrimitives;
}

/** The full service-tests generate: owns options + layout, runs the shared orchestration with a dialect's test primitive. */
export function generateServiceTestsFiles(
  input: GenerateServiceTestsFilesInput,
): GeneratedFile[] {
  const {
    services,
    viewTypes,
    datasourceTypes,
    routes,
    settings,
    language,
    primitives,
  } = input;
  const ds = datasourceSettingsForSettings(settings);
  const generateOptions = {
    ...primitives.defaultGenerateOptions,
    ...caseOptionsFromSettings(settings, language as string),
    idType: ds.idType,
    datasourceSettings: ds,
    ...configKnobsFromSettings(settings, language as string),
    language,
  } as ServiceGenerateOptions;
  return buildGenericTestFiles({
    servicesData: services as ServicesData,
    viewData: viewTypes as RawTypesDoc,
    datasourceData: datasourceTypes as RawTypesDoc,
    routesData: routes as ServicesRoutesData | null,
    primitives,
    generateOptions,
  });
}

/** Shared service-tests step: dispatch to the language generator, thread customServiceNames for the write plan. */
export function dispatchServiceTestsStep(generator: LanguageGeneratorModule) {
  return (input: StepInput) =>
    runServicesDispatch(generator, input, {
      validLanguages: SUPPORTED_LANGUAGES as string[],
      withRoutes: true,
      invalidExtra: { customServiceNames: [] },
      resultExtra: (prep) => ({
        customServiceNames: prep.servicesData.services.map((e) =>
          kebabOfServiceName(e.name),
        ),
      }),
    });
}

/** Service *integration* tests are generated only for m2m junctions — the multi-FK-parent seed case that needs a real DB round-trip. Every other entity is covered by the lighter `service_tests`. (Junctions are first-class enriched view types now, so select them by their datasource kind, not by the absence of a view.) */
function buildIntegrationTestFiles({
  servicesData,
  viewData,
  datasourceData,
  primitives,
  generateOptions,
}: {
  servicesData: ServicesData;
  viewData: RawTypesDoc;
  datasourceData: RawTypesDoc;
  primitives: ServiceIntegrationPrimitives;
  generateOptions: ServiceGenerateOptions;
}): GeneratedFile[] {
  const block = serviceViewTypeDirective(servicesData);
  if (!block) return [];
  const explicitNames = new Set(
    (servicesData.services ?? []).map((s) => s.name),
  );
  const expandedView = expandViewTypes(viewData, datasourceData, {
    mode: "service",
  });
  const candidates = buildCandidates(
    expandedView,
    datasourceData,
  ) as ServiceCandidate[];
  const predicate = compileServicesFilter(block.filter);
  const survivors = candidates
    .filter(predicate)
    .filter((c) => c.datasourceType === "many-to-many");
  survivors.sort((a, b) => a.name.localeCompare(b.name));
  return generateSurvivorFiles(survivors, { explicitNames, generateOptions }, (cand) =>
    primitives.generateGenericServiceIntegrationTest(cand, {
      ...generateOptions,
      datasource: datasourceData,
    }),
  );
}

interface GenerateServiceIntegrationTestsFilesInput extends ServiceTestsGenerateConfig {
  primitives: ServiceIntegrationPrimitives;
}

export function generateServiceIntegrationTestsFiles(
  input: GenerateServiceIntegrationTestsFilesInput,
): GeneratedFile[] {
  const {
    services,
    viewTypes,
    datasourceTypes,
    settings,
    language,
    primitives,
  } = input;
  const ds = datasourceSettingsForSettings(settings);
  const generateOptions = {
    ...primitives.defaultGenerateOptions,
    ...caseOptionsFromSettings(settings, language as string),
    datetime: ds.datetimeRepr,
    pluralizeTableNames: ds.pluralizeTableNames,
    idType: ds.idType,
    ...configKnobsFromSettings(settings, language as string),
    language,
  } as ServiceGenerateOptions;
  return buildIntegrationTestFiles({
    servicesData: services as ServicesData,
    viewData: viewTypes as RawTypesDoc,
    datasourceData: datasourceTypes as RawTypesDoc,
    primitives,
    generateOptions,
  });
}

export function dispatchServiceIntegrationTestsStep(
  generator: LanguageGeneratorModule,
) {
  return (input: StepInput) =>
    runServicesDispatch(generator, input, {
      validLanguages: SUPPORTED_LANGUAGES as string[],
    });
}

interface ServicesStepConfig {
  dispatchStep: (
    generator: LanguageGeneratorModule,
  ) => (input: StepInput) => unknown;
  generator: LanguageGeneratorModule;
  language: string;
}

/** Catalog `{ inputs, settings }` adapter for the services family: the step's own YAML is `services.yaml`. Thin over the shared `catalogStepGenerate`. */
export const servicesStepGenerate = <TCtx>(config: ServicesStepConfig, ctx: TCtx) =>
  catalogStepGenerate(
    { ...config, primary: "servicesYamlText" },
    ctx as Parameters<typeof catalogStepGenerate>[1],
  );
