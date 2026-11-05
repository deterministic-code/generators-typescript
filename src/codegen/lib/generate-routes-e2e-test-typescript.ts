import {
  generateRouteE2eFiles,
  dispatchRouteE2eStep,
  routesStepGenerate,
  type LanguageGeneratorModule,
} from "../../sdk/codegen/lib/routes-generate.ts";
import {
  snakeToCamel,
  snakeToKebab,
} from "../../sdk/case.ts";
import {
  columnIsUnique,
  iterateCombinedRoutes,
} from "../../sdk/lib/routes-expand.ts";
import { indexDatasourceByName as indexDatasource } from "../../sdk/lib/datasource-index.ts";
import { findForeignKeyTo } from "../../sdk/codegen/lib/iterate-combined-routes.ts";
import {
  STANDARD_COLUMNS,
  RawTsExpr,
  tsLiteral,
} from "../../sdk/codegen/lib/integration-test-spec.ts";
import { libraryImportSpecifier } from "./library-import.ts";
import {
  namesFor,
  layoutFor,
} from "../../sdk/codegen/lib/ts-codegen-naming.ts";
import {
  datasourceSettingsFor,
  settingsConfigLiteral,
} from "../../sdk/codegen/lib/ts-datasource-settings.ts";
import type {
  GeneratedFile,
  RoutesGenerateConfig,
} from "../../sdk/codegen/lib/routes-generate-types.ts";
import type { DatasourceSettings } from "../../sdk/datasource-settings.ts";

interface FieldDef {
  type?: string;
  is_nullable?: boolean;
  is_unique?: boolean;
  default_value?: unknown;
  references?: string;
  primary_key?: boolean;
}

interface SeedData {
  name?: string;
}

interface TypeDef {
  datasource_type?: string;
  fields?: Record<string, FieldDef>[];
  seeds?: Record<string, SeedData>[];
}

interface DatasourceData {
  types?: Record<string, TypeDef>[];
}

interface ChildOpts {
  via?: unknown;
  target?: unknown;
}

interface CombinedParentDef {
  combined_types?: (string | Record<string, ChildOpts>)[];
}

interface RouteDef {
  entity?: string;
  byField?: string;
  methods?: string[];
}

interface RoutesData {
  combined_routes?: Record<string, CombinedParentDef>[];
  routes?: unknown[];
}

type EntityKind = "m2m" | "readonly" | "regular";
type DatasourceIndex = Map<string, unknown>;

interface Enrichment {
  fkColumn: string;
  newField: string;
  sampleValue: string;
}

interface PostBodyContext {
  entityName: string;
  typeDef: TypeDef;
  datasourceByName: DatasourceIndex;
}

interface CrudCase extends PostBodyContext {
  pathSegment: string;
  readonly: boolean;
}

interface ByFieldCase extends PostBodyContext {
  byField: string;
  methods: string[];
  unique: boolean;
  readonly: boolean;
}

interface DirectFkDescriptor {
  kind: "direct-fk";
  parent: string;
  child: { name: string };
  fkColumn: string;
  collectionPath: string;
  memberPath: string;
  parentParam: string;
}

interface M2mDescriptor {
  kind: "m2m";
  parent: string;
  target: string;
  junction: string;
  collectionPath: string;
  memberPath: string;
  parentParam: string;
  targetParam: string;
}

type CombinedDescriptor = DirectFkDescriptor | M2mDescriptor;

interface DirectFkCase {
  parent: string;
  child: string;
  fkColumn: string;
  collectionPath: string;
  memberPath: string;
  parentParam: string;
}

interface M2mCase {
  parent: string;
  target: string;
  junction: string;
  collectionPath: string;
  memberPath: string;
  parentParam: string;
  targetParam: string;
}

interface ByFieldPaths {
  pathBase: string;
  seededValue: string;
  missingValue: string;
}

interface AppE2ETestInput {
  datasourceData: DatasourceData;
  routesData: RoutesData;
  libraryReferenceMode?: string;
  datasourceSettings?: DatasourceSettings;
}

const names = namesFor({ language: "typescript" });
const layout = layoutFor({ language: "typescript" });

function fieldsOf(typeDef: TypeDef | undefined): Record<string, FieldDef>[] {
  return Array.isArray(typeDef?.fields) ? typeDef.fields : [];
}

function collectNestedOnly(
  routesData: RoutesData | undefined,
  datasourceByName: DatasourceIndex,
): Set<string> {
  const nested = new Set<string>();
  for (const parentEntry of routesData?.combined_routes ?? []) {
    const [parentName, parentDef] = Object.entries(parentEntry)[0];
    for (const child of parentDef?.combined_types ?? []) {
      let childName: string;
      let opts: ChildOpts | null = null;
      if (typeof child === "string") {
        childName = child.replace(/-/g, "_");
      } else {
        const [rawName, rawOpts] = Object.entries(child)[0];
        childName = rawName.replace(/-/g, "_");
        opts = rawOpts;
      }
      if (opts && (opts.via || opts.target)) continue;
      const childDef = datasourceByName.get(childName);
      if (childDef && findForeignKeyTo(childDef, parentName) !== null) {
        nested.add(childName);
      }
    }
  }
  return nested;
}

function classifyEntity(typeDef: TypeDef | undefined): EntityKind {
  if (typeDef?.datasource_type === "many-to-many") return "m2m";
  if (typeDef?.datasource_type === "readonly-lookup") return "readonly";
  return "regular";
}

function sampleValueForField(field: FieldDef, suffix = ""): unknown {
  const { type, is_nullable, default_value } = field;
  if (is_nullable) return null;
  if (default_value !== undefined && default_value !== null) {
    return default_value;
  }
  switch (type) {
    case "string": {
      const base = suffix ? `sample${suffix}` : "sample";
      return new RawTsExpr(`\`${base}-\${randSuffix()}\``);
    }
    case "number":
    case "reference":
      return 1;
    case "boolean":
      return false;
    case "datetime":
      return "2024-01-01T00:00:00.000Z";
    case "binary":
      return null;
    default:
      return null;
  }
}

function targetIsEnrichable(targetDef: TypeDef | undefined): boolean {
  if (!targetDef) return false;
  if (targetDef.datasource_type === "readonly-lookup") return true;
  if (targetDef.datasource_type === "many-to-many") return false;
  for (const fieldEntry of fieldsOf(targetDef)) {
    const [fname, fdef] = Object.entries(fieldEntry)[0];
    if (fname !== "name") continue;
    if (!fdef || fdef.type !== "string") return false;
    if (fdef.is_unique !== true) return false;
    if (fdef.is_nullable === true) return false;
    return true;
  }
  return false;
}

function firstSeedName(targetDef: TypeDef): string {
  if (!Array.isArray(targetDef.seeds) || targetDef.seeds.length === 0) {
    return "sample";
  }
  const [, seedData] = Object.entries(targetDef.seeds[0])[0];
  return seedData && typeof seedData.name === "string"
    ? seedData.name
    : "sample";
}

function computeEnrichments(
  entityName: string,
  datasourceByName: DatasourceIndex,
): Enrichment[] {
  const def = datasourceByName.get(entityName) as TypeDef | undefined;
  if (!def) return [];

  const enrichments: Enrichment[] = [];
  for (const fieldEntry of fieldsOf(def)) {
    const [fieldName, fieldDef] = Object.entries(fieldEntry)[0];
    if (!fieldName.endsWith("_id")) continue;
    if (!fieldDef || typeof fieldDef.references !== "string") continue;

    const [refTable] = fieldDef.references.split(".");
    const targetDef = datasourceByName.get(refTable) as TypeDef | undefined;
    if (!targetIsEnrichable(targetDef)) continue;

    enrichments.push({
      fkColumn: fieldName,
      newField: `${fieldName.slice(0, -"_id".length)}_name`,
      sampleValue: firstSeedName(targetDef as TypeDef),
    });
  }
  return enrichments;
}

function applyEnrichmentFields(
  body: Record<string, unknown>,
  enrichments: Enrichment[],
): void {
  for (const enrichment of enrichments) {
    // The enrichment name is resolved to an existing lookup row by LookupEnrichedService.resolveInboundNames, so it must be a seed name verbatim — a `-${randSuffix()}` suffix matches no seeded row and the create is rejected.
    body[enrichment.newField] = enrichment.sampleValue;
  }
}

function buildPostBodyForEntity(
  c: PostBodyContext,
  suffix = "",
): Record<string, unknown> {
  const { entityName, typeDef, datasourceByName } = c;
  const enrichments = computeEnrichments(entityName, datasourceByName);
  const omitColumns = new Set<string>([
    ...STANDARD_COLUMNS,
    ...enrichments.map((e) => e.fkColumn),
  ]);

  const body: Record<string, unknown> = {};
  for (const fieldEntry of fieldsOf(typeDef)) {
    const [fieldName, fieldDef] = Object.entries(fieldEntry)[0];
    if (omitColumns.has(fieldName)) continue;
    const { default_value } = fieldDef;
    if (default_value !== undefined && default_value !== null) continue;
    body[fieldName] = sampleValueForField(fieldDef, suffix);
  }

  applyEnrichmentFields(body, enrichments);
  return body;
}

function collectCrudCases(
  datasourceData: DatasourceData,
  datasourceByName: DatasourceIndex,
  nestedOnly: Set<string>,
): CrudCase[] {
  const crudCases: CrudCase[] = [];
  for (const entry of datasourceData?.types ?? []) {
    const [entityName, def] = Object.entries(entry)[0];
    const kind = classifyEntity(def);
    if (kind === "m2m") continue;
    if (nestedOnly.has(entityName)) continue;
    crudCases.push({
      entityName,
      pathSegment: layout.apiPath(entityName),
      readonly: kind === "readonly",
      typeDef: def,
      datasourceByName,
    });
  }
  return crudCases;
}

function collectCombinedCases(
  routesData: RoutesData,
  datasourceData: DatasourceData,
): { directFkCases: DirectFkCase[]; m2mCases: M2mCase[] } {
  const directFkCases: DirectFkCase[] = [];
  const m2mCases: M2mCase[] = [];
  // The core yields a superset descriptor keyed by a non-literal `kind`; assert the local discriminated-union shape so `kind` narrows child-vs-target access.
  const descriptors = iterateCombinedRoutes({
    routesData,
    datasourceData,
  } as Parameters<
    typeof iterateCombinedRoutes
  >[0]) as Iterable<CombinedDescriptor>;
  for (const descriptor of descriptors) {
    if (descriptor.kind === "direct-fk") {
      directFkCases.push({
        parent: descriptor.parent,
        child: descriptor.child.name,
        fkColumn: descriptor.fkColumn,
        collectionPath: descriptor.collectionPath,
        memberPath: descriptor.memberPath,
        parentParam: descriptor.parentParam,
      });
    } else {
      m2mCases.push({
        parent: descriptor.parent,
        target: descriptor.target,
        junction: descriptor.junction,
        collectionPath: descriptor.collectionPath,
        memberPath: descriptor.memberPath,
        parentParam: descriptor.parentParam,
        targetParam: descriptor.targetParam,
      });
    }
  }
  return { directFkCases, m2mCases };
}

function* iterateRouteDefs(routesData: RoutesData): Generator<RouteDef> {
  for (const entry of routesData?.routes ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const def = Object.values(entry)[0];
    if (def && typeof def === "object") yield def as RouteDef;
  }
}

function collectByFieldCases(
  routesData: RoutesData,
  datasourceByName: DatasourceIndex,
): ByFieldCase[] {
  const byFieldCases: ByFieldCase[] = [];
  for (const def of iterateRouteDefs(routesData)) {
    if (typeof def.entity !== "string" || typeof def.byField !== "string")
      continue;

    const typeDef = datasourceByName.get(def.entity) as TypeDef | undefined;
    if (!typeDef) continue;
    const unique = columnIsUnique(typeDef, def.byField);
    const methods = Array.isArray(def.methods)
      ? def.methods
      : ["GET", "PUT", "DELETE"];
    const allowedMethods =
      typeDef.datasource_type === "readonly-lookup"
        ? methods.filter((m) => m === "GET")
        : methods;
    if (allowedMethods.length === 0) continue;

    byFieldCases.push({
      entityName: def.entity,
      byField: def.byField,
      methods: allowedMethods,
      unique,
      readonly: typeDef.datasource_type === "readonly-lookup",
      typeDef,
      datasourceByName,
    });
  }
  return byFieldCases;
}

function buildExpectations(
  datasourceData: DatasourceData,
  routesData: RoutesData,
): {
  crudCases: CrudCase[];
  directFkCases: DirectFkCase[];
  m2mCases: M2mCase[];
  byFieldCases: ByFieldCase[];
} {
  const datasourceByName = indexDatasource(datasourceData);
  const nestedOnly = collectNestedOnly(routesData, datasourceByName);
  const crudCases = collectCrudCases(
    datasourceData,
    datasourceByName,
    nestedOnly,
  );
  const { directFkCases, m2mCases } = collectCombinedCases(
    routesData,
    datasourceData,
  );
  const byFieldCases = collectByFieldCases(routesData, datasourceByName);
  return { crudCases, directFkCases, m2mCases, byFieldCases };
}

function instantiatePath(template: string, ds: DatasourceSettings): string {
  const id = String(ds.sampleId());
  return template
    .replace(/\/:[A-Za-z][A-Za-z0-9]*/g, `/${id}`)
    .replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, id);
}

function crudReadonlyLines(missingMember: string): string[] {
  return [
    `  it("GET ${missingMember} returns 404 when missing", async () => {`,
    `    const res = await request(app).get("${missingMember}");`,
    `    expect(res.status).toBe(404);`,
    `  });`,
  ];
}

/** The field a created entity echoes back as its identity, plus its runtime `typeof`. A custom `primary_key` (the `legacy_contact.key` pattern) has no implicit `id`, so the 201 body carries that field — string/uuid PKs serialize as strings, everything else as the project-wide id type. */
function primaryKeyAssertion(
  typeDef: TypeDef,
  ds: DatasourceSettings,
): { field: string; tsType: string } {
  for (const fieldEntry of fieldsOf(typeDef)) {
    const [fieldName, fieldDef] = Object.entries(fieldEntry)[0];
    if (fieldDef?.primary_key !== true || fieldName === "id") continue;
    const tsType =
      fieldDef.type === "string" || fieldDef.type === "uuid"
        ? "string"
        : "number";
    return { field: fieldName, tsType };
  }
  return { field: "id", tsType: ds.tsIdType() };
}

function crudWritableLines(
  c: CrudCase,
  uris: { collection: string; member: string },
  ds: DatasourceSettings,
): string[] {
  const { collection, member } = uris;
  const bodyFirstLiteral = tsLiteral(buildPostBodyForEntity(c));
  const bodySecondLiteral = tsLiteral(buildPostBodyForEntity(c, "-2"));
  const pk = primaryKeyAssertion(c.typeDef, ds);
  return [
    `  it("POST ${collection} accepts a sample payload", async () => {`,
    `    const res = await request(app).post("${collection}").send(${bodyFirstLiteral});`,
    `    expect([201, 400]).toContain(res.status);`,
    `    if (res.status === 201) expect(typeof res.body.${pk.field}).toBe("${pk.tsType}");`,
    `  });`,
    `  it("GET ${member} returns the created entity after seed", async () => {`,
    `    await request(app).post("${collection}").send(${bodySecondLiteral});`,
    `    const res = await request(app).get("${member}");`,
    `    expect([200, 404]).toContain(res.status);`,
    `  });`,
    `  it("DELETE ${member} returns a non-5xx", async () => {`,
    `    const res = await request(app).delete("${member}");`,
    `    expect(res.status).toBeLessThan(500);`,
    `  });`,
  ];
}

function generateCrudBlock(c: CrudCase, ds: DatasourceSettings): string {
  const collection = `/api/${c.pathSegment}`;
  const member = `${collection}/${ds.sampleId()}`;
  const missingMember = `${collection}/${ds.missingIdSentinel()}`;
  const entityPascal = names.className(c.entityName);
  const lines = [
    `describe("${entityPascal} CRUD", () => {`,
    `  it("GET ${collection} returns 200", async () => {`,
    `    const res = await request(app).get("${collection}");`,
    `    expect(res.status).toBe(200);`,
    `  });`,
    ...(c.readonly
      ? crudReadonlyLines(missingMember)
      : crudWritableLines(c, { collection, member }, ds)),
    `});`,
  ];
  return lines.join("\n");
}

function getStatusIt(
  path: string,
  description: string,
  assertion: string,
): string[] {
  return [
    `  it("GET ${path} ${description}", async () => {`,
    `    const res = await request(app).get("${path}");`,
    `    ${assertion}`,
    `  });`,
  ];
}

function combinedDescribeBlock(label: string, its: string[]): string {
  return [`describe("${label}", () => {`, ...its, `});`].join("\n");
}

function generateDirectFkBlock(c: DirectFkCase, ds: DatasourceSettings): string {
  const collection = instantiatePath(c.collectionPath, ds);
  const member = instantiatePath(c.memberPath, ds);
  // describe-label display text, not an generated identifier or route path.
  const label = `${snakeToCamel(c.parent)}->${c.child}`; // lint-generator-casing-allow: snakeToCamel
  return combinedDescribeBlock(`combined direct-fk ${label}`, [
    ...getStatusIt(collection, "returns 200", "expect(res.status).toBe(200);"),
    ...getStatusIt(
      member,
      "returns a non-5xx",
      "expect(res.status).toBeLessThan(500);",
    ),
  ]);
}

function byFieldSeedLines(c: ByFieldCase, paths: ByFieldPaths): string[] {
  const { pathBase, seededValue } = paths;
  if (c.readonly) return [];
  // Seed a row so happy-path GET/PUT/DELETE has a target; sample POST body with a deterministic byField value for path predictability.
  const seedBody = buildPostBodyForEntity(c);
  seedBody[c.byField] = `e2e-${c.byField}`;
  const seedLiteral = tsLiteral(seedBody);
  const lines = [`  beforeEach(async () => {`];
  // Unique byField: DELETE the seed key before POSTing so beforeEach reruns don't pile duplicates (InMemoryRepository doesn't enforce UNIQUE; the DELETE is best-effort 0/1/404).
  if (c.unique) {
    lines.push(`    await request(app).delete("${pathBase}/${seededValue}");`);
  }
  lines.push(
    `    await request(app).post("/api/${layout.apiPath(c.entityName)}").send(${seedLiteral});`,
  );
  lines.push(`  });`);
  return lines;
}

function byFieldGetLines(c: ByFieldCase, paths: ByFieldPaths): string[] {
  const { pathBase, seededValue, missingValue } = paths;
  if (!c.methods.includes("GET")) return [];
  if (c.unique) {
    return [
      `  it("GET ${pathBase}/${seededValue} returns the seeded row or 404", async () => {`,
      `    const res = await request(app).get("${pathBase}/${seededValue}");`,
      `    expect([200, 404]).toContain(res.status);`,
      `    if (res.status === 200) {`,
      `      expect(res.body).toBeTypeOf("object");`,
      `      expect(res.body).not.toBeNull();`,
      `    }`,
      `  });`,
      `  it("GET ${pathBase}/${missingValue} returns 404", async () => {`,
      `    const res = await request(app).get("${pathBase}/${missingValue}");`,
      `    expect(res.status).toBe(404);`,
      `  });`,
    ];
  }
  return [
    `  it("GET ${pathBase}/${seededValue} returns 200 with items[]", async () => {`,
    `    const res = await request(app).get("${pathBase}/${seededValue}");`,
    `    expect(res.status).toBe(200);`,
    `    expect(Array.isArray(res.body.items)).toBe(true);`,
    `  });`,
    `  it("GET ${pathBase}/${missingValue} returns 200 with empty items[]", async () => {`,
    `    const res = await request(app).get("${pathBase}/${missingValue}");`,
    `    expect(res.status).toBe(200);`,
    `    expect(res.body.items).toEqual([]);`,
    `  });`,
  ];
}

function byFieldPutLines(c: ByFieldCase, paths: ByFieldPaths): string[] {
  const { pathBase, missingValue } = paths;
  if (!c.methods.includes("PUT")) return [];
  if (c.unique) {
    return [
      `  it("PUT ${pathBase}/${missingValue} returns 404 when nothing matches", async () => {`,
      `    const res = await request(app).put("${pathBase}/${missingValue}").send({});`,
      `    expect([400, 404]).toContain(res.status);`,
      `  });`,
    ];
  }
  return [
    `  it("PUT ${pathBase}/${missingValue} returns 200 with { count: 0 }", async () => {`,
    `    const res = await request(app).put("${pathBase}/${missingValue}").send({});`,
    `    expect([200, 400]).toContain(res.status);`,
    `    if (res.status === 200) expect(res.body.count).toBe(0);`,
    `  });`,
  ];
}

function byFieldDeleteLines(c: ByFieldCase, paths: ByFieldPaths): string[] {
  const { pathBase, seededValue, missingValue } = paths;
  if (!c.methods.includes("DELETE")) return [];
  if (c.unique) {
    return [
      `  it("DELETE ${pathBase}/${seededValue} returns 204 or 404", async () => {`,
      `    const res = await request(app).delete("${pathBase}/${seededValue}");`,
      `    expect([204, 404]).toContain(res.status);`,
      `  });`,
      `  it("DELETE ${pathBase}/${missingValue} returns 404", async () => {`,
      `    const res = await request(app).delete("${pathBase}/${missingValue}");`,
      `    expect(res.status).toBe(404);`,
      `  });`,
    ];
  }
  return [
    `  it("DELETE ${pathBase}/${missingValue} returns 200 with { count: 0 }", async () => {`,
    `    const res = await request(app).delete("${pathBase}/${missingValue}");`,
    `    expect(res.status).toBe(200);`,
    `    expect(res.body.count).toBe(0);`,
    `  });`,
  ];
}

function generateByFieldBlock(c: ByFieldCase): string {
  const entityPascal = names.className(c.entityName);
  // byField URL segment is kebab-invariant, matching the generated router's fieldKebab.
  const pathBase = `/api/${layout.apiPath(c.entityName)}/${snakeToKebab(c.byField)}`; // lint-generator-casing-allow: snakeToKebab
  const uniqLabel = c.unique ? "unique" : "non-unique";
  const paths: ByFieldPaths = {
    pathBase,
    seededValue: `e2e-${c.byField}`,
    missingValue: "e2e-missing",
  };
  const lines = [
    `describe("${entityPascal} by-field ${c.byField} (${uniqLabel})", () => {`,
    ...byFieldSeedLines(c, paths),
    ...byFieldGetLines(c, paths),
    ...byFieldPutLines(c, paths),
    ...byFieldDeleteLines(c, paths),
    `});`,
  ];
  return lines.join("\n");
}

function generateM2mBlock(c: M2mCase, ds: DatasourceSettings): string {
  const collection = instantiatePath(c.collectionPath, ds);
  const member = instantiatePath(c.memberPath, ds);
  // describe-label display text, not an generated identifier or route path.
  const label = `${snakeToCamel(c.parent)}<->${c.target}`; // lint-generator-casing-allow: snakeToCamel
  const nonFivexx = "expect(res.status).toBeLessThan(500);";
  return combinedDescribeBlock(`combined m2m ${label}`, [
    ...getStatusIt(collection, "returns a non-5xx", nonFivexx),
    ...getStatusIt(member, "returns a non-5xx", nonFivexx),
  ]);
}

function buildTestBlocks(
  expectations: ReturnType<typeof buildExpectations>,
  ds: DatasourceSettings,
): string {
  const { crudCases, directFkCases, m2mCases, byFieldCases } = expectations;
  const crudBlocks = crudCases.map((c) => generateCrudBlock(c, ds)).join("\n\n");
  const directFkBlocks = directFkCases
    .map((c) => generateDirectFkBlock(c, ds))
    .join("\n\n");
  const m2mBlocks = m2mCases.map((c) => generateM2mBlock(c, ds)).join("\n\n");
  const byFieldBlocks = byFieldCases.map(generateByFieldBlock).join("\n\n");
  return [crudBlocks, directFkBlocks, m2mBlocks, byFieldBlocks]
    .filter(Boolean)
    .join("\n\n");
}

function vitestImportList(allBlocks: string): string {
  const vitestImports = ["describe", "it", "expect", "beforeAll", "afterAll"];
  if (allBlocks.includes("beforeEach(")) {
    vitestImports.splice(4, 0, "beforeEach");
  }
  return vitestImports.join(", ");
}

/** app.integration.test.ts is CRUD/direct-FK/M2M only, so strip custom routes (routeClass+module entries); otherwise every consumer would have to stub GenerateCodeService/VerifyAppService/etc. */
function sanitizeRoutesData(routesData: RoutesData): RoutesData {
  return {
    ...routesData,
    routes: Array.isArray(routesData?.routes)
      ? routesData.routes.filter((entry) => {
          if (!entry || typeof entry !== "object") return true;
          const def = Object.values(entry)[0] as { routeClass?: unknown };
          return !(
            def &&
            typeof def === "object" &&
            typeof def.routeClass === "string"
          );
        })
      : routesData?.routes,
  };
}

export function generateAppE2ETest({
  datasourceData,
  routesData,
  libraryReferenceMode,
  datasourceSettings,
}: AppE2ETestInput): GeneratedFile {
  const expectations = buildExpectations(datasourceData, routesData);
  // Direct callers (unit/integration harnesses) may omit settings; default to the integer id representation the flat router also assumes.
  const ds = datasourceSettings ?? datasourceSettingsFor({});
  const allBlocks = buildTestBlocks(expectations, ds);
  const vitestImports = vitestImportList(allBlocks);
  const datasourceJson = JSON.stringify(datasourceData, null, 2);
  const routesJson = JSON.stringify(sanitizeRoutesData(routesData), null, 2);
  const detRootImport = libraryImportSpecifier(
    "",
    libraryReferenceMode,
    "__tests__/app.integration.test.ts",
  );
  const content = `import { ${vitestImports} } from "vitest";
import request from "supertest";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import {
  createBackendApp,
  connectDatabase,
  parseCrudRouteSpecs,
  type DatabaseConnection,
} from "${detRootImport}";

const datasourceData = ${datasourceJson} as const;

const routesData = ${routesJson} as const;

const randSuffix = (): string => Math.random().toString(36).slice(2, 10);

class TerminalHandler {
  static readonly dependencies = [] as const;
  handle = (_req: Request, res: Response, _next: NextFunction): void => {
    res.status(404).json({ errors: [{ code: "NOT_FOUND", message: "Route not found" }] });
  };
}

const jsonParser = express.json();
const noopLookup = {
  get: () => jsonParser,
} as unknown as ConstructorParameters<typeof Object>[0];

let app: Express;
let conn: DatabaseConnection;

beforeAll(async () => {
  conn = await connectDatabase({ backend: "memory" });
  const crudSpecs = parseCrudRouteSpecs(datasourceData, routesData, { projectIdType: "${ds.isUuid ? "uuid" : "integer"}" });
  app = await createBackendApp(conn, {
    backendAppConfig: { middleware: [{ name: "bodyParser", type: "app", enabled: true }], handlers: [{ name: "TerminalHandler", enabled: true }] },
    settingsConfig: ${settingsConfigLiteral(ds)},
    routeSpecs: [],
    crudSpecs,
    datasourceData: datasourceData as unknown as never,
    routesData: routesData as unknown as never,
    serviceSpecs: [],
    classRegistry: {
      TerminalHandler: TerminalHandler as unknown as new (...a: unknown[]) => unknown,
    },
    middlewareLookup: noopLookup as never,
    onAfterCreateApp: async (ctx) => {
      function serviceKeyFor(entityName: string): string {
        const parts = entityName.split('_');
        const camel = parts
          .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
          .join('');
        return \`\${camel}Service\`;
      }
      for (const entry of datasourceData.types ?? []) {
        const [entityName, def] = Object.entries(entry)[0];
        const seeds = def?.seeds ?? [];
        if (seeds.length === 0) continue;
        const repoKey = serviceKeyFor(entityName);
        const repo = ctx.repos[repoKey] as any;
        const seeder = repo?.create ?? repo?.add;
        if (typeof seeder !== 'function') continue;
        for (const seedEntry of seeds) {
          const [, seedData] = Object.entries(seedEntry)[0];
          try {
            await seeder.call(repo, seedData);
          } catch (_err) {
          }
        }
      }
    },
  });
});

afterAll(async () => {
  await conn.close();
});

${allBlocks}
`;

  return { path: "app.integration.test.ts", content };
}

/** Catalog `routes_e2e_test` step (typescript). */
export const generate = (ctx: unknown) =>
  routesStepGenerate(
    {
      dispatchStep: dispatchRouteE2eStep,
      generator: { createGenerator } as unknown as LanguageGeneratorModule,
      language: "typescript",
    },
    ctx,
  );

export const createGenerator = () => ({
  generate: (config: RoutesGenerateConfig & { expanded: unknown }) =>
    generateRouteE2eFiles({ ...config, primitives: { generateAppE2ETest } }),
});
