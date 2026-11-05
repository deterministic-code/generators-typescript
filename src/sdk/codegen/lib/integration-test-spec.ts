import { buildDatasourceFixture, indexDatasource } from "./fixture-builder.ts";
import { resolveFkSeedPlan } from "./datasource-fk-deps.ts";
import { namesFor } from "./ts-codegen-naming.ts";
import type { NamesForOptions } from "./ts-codegen-naming.ts";
import { effectiveTableName } from "../../lib/effective-table-name.ts";
import { buildComponents } from "../../lib/schema-build.ts";
import { sampleFromSchema } from "./schema-sample.ts";
import { generateCreateTable, normalizeTable } from "../../lib/generate-sql.ts";
import type { SqlDialect, SeedValue, RawIndexDef } from "../../lib/generate-sql.ts";
import { computeEnrichmentsForDatasourceType } from "../../view-expand.ts";
import type { Enrichment } from "../../view-expand.ts";
import type { RawTypesDoc } from "../../deterministic-shapes.ts";
import type { JsonValue } from "../../read-settings.ts";
export { RawTsExpr, tsLiteral } from "./ts-sample-literal.ts";
import type { RuntimeValue } from "./ts-sample-literal.ts";

export const STANDARD_COLUMNS = ["id", "uuid", "created", "updated"];

const STANDARD_COLUMNS_SET = new Set(STANDARD_COLUMNS);

type SampleValue =
  | string
  | number
  | boolean
  | null
  | RuntimeValue
  | SampleValue[]
  | { [key: string]: SampleValue };

interface DsFieldDef {
  type: string;
  size?: number;
  is_nullable?: boolean;
  is_unique?: boolean;
  primary_key?: boolean;
  references?: string;
  default_value?: SeedValue;
}

interface DsTypeDef {
  datasource_type?: string;
  fields: Array<Record<string, DsFieldDef>>;
  indexes?: Record<string, RawIndexDef>[];
  seeds?: Record<string, Record<string, SeedValue>>[];
  skip_migrations?: boolean;
}

interface DatasourceSpecDoc {
  types: Array<Record<string, DsTypeDef>>;
}

interface EntityCandidate {
  name: string;
  kind: string;
}

export interface IntegrationTestOpts extends NamesForOptions {
  datasource?: DatasourceSpecDoc;
  pluralizeTableNames?: boolean;
  datetime?: string;
  enrichForApi?: boolean;
  dialect?: SqlDialect;
}

interface FieldRef {
  name: string;
  type: string;
}

type EntityDef = NonNullable<
  ReturnType<ReturnType<typeof indexDatasource>["get"]>
>;
type EntityField = EntityDef["fields"][number];

function pickStringField(fields: EntityDef["fields"]): EntityField | null {
  for (const f of fields) {
    if (f.type === "string" && !f.isNullable && f.name !== "uuid") return f;
  }
  for (const f of fields) {
    if (f.type === "string" && f.name !== "uuid") return f;
  }
  return null;
}

function lookupTableSeedName(
  targetTable: string,
  datasourceData: DatasourceSpecDoc,
): string {
  for (const entry of datasourceData.types) {
    if (Object.keys(entry)[0] !== targetTable) continue;
    const seeds = Object.values(entry)[0].seeds ?? [];
    for (const seed of seeds) {
      const seedDef = Object.values(seed)[0];
      if (
        seedDef &&
        typeof seedDef.name === "string" &&
        seedDef.name.length > 0
      ) {
        return seedDef.name;
      }
    }
  }
  throw new Error(
    `lookupTableSeedName: no seed row with a "name" field on "${targetTable}" — enrichment requires one`,
  );
}

function applyEnrichmentToSample(
  sample: Record<string, SampleValue>,
  enrichments: Enrichment[],
  datasourceData: DatasourceSpecDoc,
): void {
  for (const e of enrichments) {
    delete sample[e.fkColumn];
    sample[e.newField] = lookupTableSeedName(e.targetTable, datasourceData);
  }
}

function resolveEntityDef(
  candidate: EntityCandidate,
  opts: IntegrationTestOpts,
): {
  def: EntityDef;
  datasource: DatasourceSpecDoc;
  rawEntry: Record<string, DsTypeDef>;
} {
  const SUPPORTED_KINDS = new Set(["datasource_type", "view_type"]);
  if (!SUPPORTED_KINDS.has(candidate.kind)) {
    throw new Error(
      `buildServiceIntegrationTestSpec: only datasource_type or view_type candidates are supported (got "${candidate.kind}" for "${candidate.name}")`,
    );
  }
  if (!opts.datasource) {
    throw new Error(
      "buildServiceIntegrationTestSpec: opts.datasource (parsed datasource_types.yaml) is required",
    );
  }
  const datasource = opts.datasource;
  const def = indexDatasource(datasource).get(candidate.name);
  if (!def) {
    throw new Error(
      `buildServiceIntegrationTestSpec: no datasource type named "${candidate.name}" — view_type candidates must reference an existing datasource_type by the same name`,
    );
  }
  const rawEntry = datasource.types.find(
    (e) => Object.keys(e)[0] === candidate.name,
  )!;
  return { def, datasource, rawEntry };
}

function pickFindByAndUpdateFields(def: EntityDef): {
  findByField: FieldRef | null;
  updateField: FieldRef | null;
  updatedValue: string | null;
} {
  const findByPick = pickStringField(def.fields);
  const updatePick = pickStringField(def.fields);
  const findByField = findByPick
    ? { name: findByPick.name, type: findByPick.type }
    : null;
  const updateField = updatePick
    ? { name: updatePick.name, type: updatePick.type }
    : null;
  // The update payload is the NEW value the test writes; a fixed sentinel differs from the (now runtime-random) original and stays consistent across the update call and the read-back assertion.
  const updatedValue = updateField ? "updated" : null;
  return { findByField, updateField, updatedValue };
}

function buildTableSchemaSql(
  rawEntry: Record<string, DsTypeDef>,
  opts: IntegrationTestOpts,
  pluralizeTableNames: boolean,
): string {
  const normalized = normalizeTable(rawEntry, { pluralizeTableNames });
  return generateCreateTable(opts.dialect ?? "sqlite", normalized, {
    skipForeignKeys: true,
  });
}

export function buildServiceIntegrationTestSpec(
  candidate: EntityCandidate,
  opts: IntegrationTestOpts = {},
) {
  const { def, datasource, rawEntry } = resolveEntityDef(candidate, opts);
  const entityName = candidate.name;

  const pluralizeTableNames = opts.pluralizeTableNames === true;
  const tableName = effectiveTableName(entityName, pluralizeTableNames);
  const names = namesFor(opts);
  const entityPascal = names.className(entityName);
  const className = names.className(entityName, "service");

  const fixture = buildDatasourceFixture({
    table: entityName,
    datasource: opts.datasource,
    datetime: opts.datetime,
  }) as Record<string, SampleValue>;
  const sample: Record<string, SampleValue> = {};
  for (const [key, value] of Object.entries(fixture)) {
    if (STANDARD_COLUMNS_SET.has(key)) continue;
    sample[key] = value;
  }

  const enrichments = opts.enrichForApi
    ? computeEnrichmentsForDatasourceType(entityName, datasource)
    : [];
  if (enrichments.length > 0) {
    applyEnrichmentToSample(sample, enrichments, datasource);
  }

  const { findByField, updateField, updatedValue } =
    pickFindByAndUpdateFields(def);

  const fkSeedPlan = resolveFkSeedPlan(entityName, {
    datasource: opts.datasource,
    datetime: opts.datetime,
    pluralizeTableNames,
  });

  return {
    entityName,
    entityPascal,
    className,
    tableName,
    sample,
    standardColumns: [...STANDARD_COLUMNS],
    findByField,
    updateField,
    updatedValue,
    fkSeedPlan,
    tableSchemaSql: buildTableSchemaSql(rawEntry, opts, pluralizeTableNames),
  };
}

export function resolveServiceIntegrationTestSpec(
  candidate: EntityCandidate,
  opts: IntegrationTestOpts,
) {
  const spec = buildServiceIntegrationTestSpec(candidate, {
    datasource: opts.datasource,
    pluralizeTableNames: opts.pluralizeTableNames,
    datetime: opts.datetime,
  });
  const {
    entityName,
    className,
    tableName,
    sample,
    findByField,
    updateField,
    updatedValue,
    fkSeedPlan,
  } = spec;
  return {
    spec,
    entityName,
    className,
    tableName,
    sample,
    findByField,
    updateField,
    updatedValue,
    fkSeedPlan,
  };
}

interface RouteDef {
  routeClass?: string;
  service?: string;
  serviceMethod?: string;
  response?: string;
}

type RouteEntry = Record<string, RouteDef>;

interface RoutesDoc {
  routes?: RouteEntry[];
}

interface MethodInfo {
  serviceMethod: string;
  responseName: string | null;
}

export interface TestAppArgs {
  datasourceData?: RawTypesDoc;
  routesData?: RoutesDoc;
  viewTypesData?: RawTypesDoc;
}

function collectCustomServiceRoutes(
  routesData: RoutesDoc,
): Map<string, MethodInfo[]> {
  const byService = new Map<string, MethodInfo[]>();
  for (const entry of routesData.routes ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const def = Object.values(entry)[0];
    if (!def || typeof def !== "object") continue;
    if (typeof def.routeClass === "string") continue;
    if (typeof def.service !== "string" || def.service.length === 0) continue;
    if (typeof def.serviceMethod !== "string" || def.serviceMethod.length === 0)
      continue;
    let methods = byService.get(def.service);
    if (!methods) {
      methods = [];
      byService.set(def.service, methods);
    }
    if (!methods.some((m) => m.serviceMethod === def.serviceMethod)) {
      methods.push({
        serviceMethod: def.serviceMethod,
        responseName: typeof def.response === "string" ? def.response : null,
      });
    }
  }
  return byService;
}

function stubClassNameFor(serviceName: string): string {
  return `${serviceName}Stub`;
}

export function buildTestAppSpec({
  datasourceData,
  routesData,
  viewTypesData,
}: TestAppArgs = {}) {
  if (!datasourceData || typeof datasourceData !== "object") {
    throw new Error("buildTestAppSpec: datasourceData is required");
  }
  if (!routesData || typeof routesData !== "object") {
    throw new Error("buildTestAppSpec: routesData is required");
  }
  if (!viewTypesData || typeof viewTypesData !== "object") {
    throw new Error("buildTestAppSpec: viewTypesData is required");
  }

  const components = buildComponents(viewTypesData, datasourceData);
  const schemasDoc = { components: { schemas: components } };

  const serviceMethodsByService = collectCustomServiceRoutes(routesData);
  const customServices = [...serviceMethodsByService.entries()].map(
    ([serviceName, methods]) => ({
      serviceName,
      stubClassName: stubClassNameFor(serviceName),
      methods: methods.map((m, idx) => {
        // why default `{}`: routes with no declared `response:` (e.g. HealthCheckService.check) get the open `{type:"object"}` schema from openapi-spec-build; stubbing `null` would land in the conformance test as res.body===null and fail ajv "must be object" — an empty object satisfies the schema and matches the runtime sendItem(returnedObject) shape
        let sampleResponse: JsonValue = {};
        if (m.responseName && schemasDoc.components.schemas[m.responseName]) {
          sampleResponse = sampleFromSchema(
            schemasDoc.components.schemas[m.responseName],
            schemasDoc,
            idx,
          ) as JsonValue;
        }
        return {
          serviceMethod: m.serviceMethod,
          responseName: m.responseName,
          sampleResponse,
        };
      }),
    }),
  );

  return { customServices };
}
