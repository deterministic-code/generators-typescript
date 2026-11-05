import type {
  GeneratedFile,
  ServiceTestsGenerateConfig,
} from "../../sdk/codegen/lib/service-tests-generate-types.ts";
import type {
  ClassifiedColumn,
  CreateStep,
  FkSeedPlan,
  IntegrationTestCandidate,
  NamedField,
  ResolvedSpec,
} from "../../sdk/codegen/lib/service-integration-tests-generate-types.ts";
import {
  generateServiceIntegrationTestsFiles,
  dispatchServiceIntegrationTestsStep,
  servicesStepGenerate,
} from "../../sdk/codegen/lib/services-generate.ts";
import { joinImport, libraryImportSpecifier } from "./library-import.ts";
import {
  resolveServiceIntegrationTestSpec,
  tsLiteral,
} from "../../sdk/codegen/lib/integration-test-spec.ts";
import type { IntegrationTestOpts } from "../../sdk/codegen/lib/integration-test-spec.ts";
import {
  layoutFor,
  namesFor,
  type NamesForOptions,
} from "../../sdk/codegen/lib/ts-codegen-naming.ts";
import { datasourceSettingsFor } from "../../sdk/codegen/lib/ts-datasource-settings.ts";
import type { DatasourceSettings } from "../../sdk/datasource-settings.ts";
import { classifyEntitySampleColumns } from "../../sdk/codegen/lib/datasource-fk-deps.ts";

interface TsGenerateOptions extends NamesForOptions {
  servicePath?: string;
  libraryReferenceMode?: string;
  datasource?: unknown;
  datetime?: string;
  pluralizeTableNames?: boolean;
  idType?: string;
  uuid?: string;
}

interface IdKnobs {
  idTsType: string;
  withUuidColumn: boolean;
  missingId: string;
  pkIdType: string;
  repoOptionFields: string[];
  serviceOptionFields: string[];
}

interface SeedRefs {
  moduleDecls: string;
  sampleDecl: string;
  seedLine: string;
  sampleRef: string;
  findByRef: string;
}

export const DEFAULT_GENERATE_OPTIONS = {
  servicePath: "..",
  fileFormat: "Camel",
  datetime: "string",
} as const;

/** The id-representation knobs an generated test derives from a `DatasourceSettings`: the TS type of `id`, whether a separate `uuid` column exists, a sentinel id no row will hold (for the missing-row branches, quoted as a TS literal), and the repository option fields that make `.add()` honor a uuid primary key. */
function idKnobsFor(ds: DatasourceSettings): IdKnobs {
  const sentinel = ds.missingIdSentinel();
  return {
    idTsType: ds.tsIdType(),
    withUuidColumn: ds.withUuidColumn,
    missingId: ds.isUuid ? JSON.stringify(sentinel) : sentinel,
    pkIdType: ds.isUuid ? "uuid" : "integer",
    repoOptionFields: ds.isUuid
      ? [`idType: "uuid"`, `withUuidColumn: false`]
      : [],
    serviceOptionFields: ds.isUuid ? [`idType: "uuid"`] : [],
  };
}

/** The `new XService(repository, options)` tail: BaseService reads `idType` to route `findById` through the id column (a uuid pk IS the row key, so the `findBy('uuid', …)` heuristic must not fire) — mirrors what the runtime service loader passes, which the direct `new` in this test would otherwise skip. */
function serviceOptionsArg(idKnobs: IdKnobs): string {
  return idKnobs.serviceOptionFields.length > 0
    ? `, { ${idKnobs.serviceOptionFields.join(", ")} }`
    : "";
}

function standardRowType({ idTsType, withUuidColumn }: IdKnobs): string {
  const uuidField = withUuidColumn ? " uuid: string;" : "";
  return `{ id: ${idTsType};${uuidField} created: string; updated: string }`;
}

function objectEntryLines(
  entries: [string, string][],
  indent: string,
): string[] {
  return entries.map(([k, expr]) => `${indent}${JSON.stringify(k)}: ${expr},`);
}

/** The entity's `create` args: FK columns read a real parent id from the seeded map (by physical table name), nullable FKs are null, the rest are literals. */
function entitySampleArgEntries(
  sample: Record<string, unknown>,
  plan: FkSeedPlan,
): [string, string][] {
  return (classifyEntitySampleColumns(sample, plan) as ClassifiedColumn[]).map(
    (c) => {
      if (c.kind === "fk")
        return [c.column, `parents[${JSON.stringify(c.parentTable)}]`];
      if (c.kind === "null") return [c.column, "null"];
      return [c.column, tsLiteral(c.value)];
    },
  );
}

function renderLookupStep(table: string, idKnobs: IdKnobs): string {
  return `  {
    const rows = await datasource.query<{ id: ${idKnobs.idTsType} }>("SELECT id FROM ${table} LIMIT 1");
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error("${table} must have a seeded row to reference");
    }
    seeded[${JSON.stringify(table)}] = id;
  }`;
}

/** The row-specific repository option fields: a `columnTypes` map for any binary column (a bare `SqliteStandardRepository` skips converters, so the base64 string never decodes and the raw text is stored instead of the bytes — routing it through `binaryFieldConverter.to` yields the `Buffer` sqlite binds) plus the `idType`/`withUuidColumn` fields that make `.add()` honor a uuid primary key. */
function repoOptionFieldsFor(
  row: Record<string, unknown>,
  idKnobs: IdKnobs,
): string[] {
  const fields: string[] = [];
  const binaryCols = Object.keys(row).filter(
    (k) => row[k] instanceof Uint8Array,
  );
  if (binaryCols.length > 0) {
    const body = binaryCols
      .map((c) => `${JSON.stringify(c)}: "binary"`)
      .join(", ");
    fields.push(`columnTypes: { ${body} }`);
  }
  fields.push(...idKnobs.repoOptionFields);
  return fields;
}

/** The full `StandardRepositoryOptions` literal a `new SqliteStandardRepository(datasource, table, …)` needs: the now-required `entityName` + the shared `primaryKeys` service (which resolves the entity's PrimaryKey/id_type), followed by any row-specific fields. Mirrors what `buildRepoForBackend` passes at runtime. */
function repoOptionsArg(
  registeredEntityName: string,
  row: Record<string, unknown>,
  idKnobs: IdKnobs,
): string {
  const fields = [
    `entityName: ${JSON.stringify(registeredEntityName)}`,
    "primaryKeys",
    ...repoOptionFieldsFor(row, idKnobs),
  ];
  return `{ ${fields.join(", ")} }`;
}

/** The module-level `PrimaryKeyService` the generated test injects into every repository it builds: one registration per entity it constructs (the entity under test plus each seeded parent table), each keyed on the same name passed as `options.entityName`. All standard id-based repos, so the PK column is always `id`. */
function renderPrimaryKeyServiceDecl(
  entityName: string,
  fkSeedPlan: FkSeedPlan,
  idKnobs: IdKnobs,
): string {
  const seededParents = fkSeedPlan.steps
    .filter((step) => step.kind === "create")
    .map((step) => step.table);
  const rows = [...new Set([entityName, ...seededParents])]
    .map(
      (name) =>
        `  { entityName: ${JSON.stringify(name)}, primaryKeyColumn: "id", primaryKeyIdType: ${JSON.stringify(idKnobs.pkIdType)} },`,
    )
    .join("\n");
  return `const primaryKeys = new PrimaryKeyService([\n${rows}\n]);`;
}

function renderCreateStep(step: CreateStep, idKnobs: IdKnobs): string {
  const entries: [string, string][] = [
    ...Object.entries(step.scalars).map(([k, v]): [string, string] => [
      k,
      tsLiteral(v),
    ]),
    ...step.fkColumns.map((fk): [string, string] => [
      fk.column,
      `seeded[${JSON.stringify(fk.parentTable)}]`,
    ]),
    ...step.nullFkColumns.map((col): [string, string] => [col, "null"]),
  ];
  const body = objectEntryLines(entries, "      ").join("\n");
  const optsArg = `, ${repoOptionsArg(step.table, step.scalars, idKnobs)}`;
  return `  seeded[${JSON.stringify(step.table)}] = (
    (await new SqliteStandardRepository<${standardRowType(idKnobs)}>(datasource, "${step.table}"${optsArg}).add({
${body}
    } as never)) as { id: ${idKnobs.idTsType} }
  ).id;`;
}

function renderSeedDeclarations(
  sample: Record<string, unknown>,
  plan: FkSeedPlan,
  idKnobs: IdKnobs,
): string {
  const argEntries = objectEntryLines(
    entitySampleArgEntries(sample, plan),
    "    ",
  ).join("\n");
  const stepBlocks = plan.steps
    .map((step) =>
      step.kind === "lookup"
        ? renderLookupStep(step.table, idKnobs)
        : renderCreateStep(step, idKnobs),
    )
    .join("\n");
  const mapType = `Record<string, ${idKnobs.idTsType}>`;
  return `function sampleArgs(parents: ${mapType}): Record<string, unknown> {
  return {
${argEntries}
  };
}

async function seedParents(datasource: SqliteDatasource): Promise<${mapType}> {
  const seeded: ${mapType} = {};
${stepBlocks}
  return seeded;
}
`;
}

function renderStrip(stripOrder: string[]): string {
  if (stripOrder.length <= 1) {
    return "    await datasource.query(`DELETE FROM ${TABLE_NAME}`);";
  }
  const tables = stripOrder.map((t) => JSON.stringify(t)).join(", ");
  return `    for (const table of [${tables}]) {
      await datasource.query(\`DELETE FROM \${table}\`);
    }`;
}

/** The library-import specifier for `@deterministic-code/deterministic/repositories`, resolved for the generated test's on-disk location (feature dir when `organizeByFeature`, else the flat `services/generated/__tests__` layout). */
function repositoriesImportFor(
  opts: TsGenerateOptions,
  fileBase: string,
  path: string,
): string {
  return libraryImportSpecifier(
    "repositories",
    opts.libraryReferenceMode,
    opts.organizeByFeature
      ? path
      : `services/generated/__tests__/${fileBase}.integration.test.ts`,
  );
}

/** The needs-seed-derived render fragments: the seed helper module declarations, the inline sample decl (only when there is nothing to seed), and the per-`it` seed line + sample references. */
function seedRefs(
  sample: Record<string, unknown>,
  plan: FkSeedPlan,
  idKnobs: IdKnobs,
): SeedRefs {
  const needsSeed = plan.needsSeed;
  return {
    moduleDecls: needsSeed
      ? `\n${renderSeedDeclarations(sample, plan, idKnobs)}`
      : "",
    sampleDecl: needsSeed
      ? ""
      : `  const sample = ${tsLiteral(sample)} as never;\n`,
    seedLine: needsSeed
      ? "const parents = await seedParents(datasource);\n    "
      : "",
    sampleRef: needsSeed ? "sampleArgs(parents) as never" : "sample",
    findByRef: needsSeed ? "sampleArgs(parents)" : "sample",
  };
}

function renderFindByBlock(
  findByField: NamedField | null,
  refs: SeedRefs,
): string {
  if (!findByField) return "";
  return `
  it("findBy returns rows matching the column", async () => {
    ${refs.seedLine}const created = await service.create(${refs.sampleRef});
    const matches = await service.findBy([{ name: ${JSON.stringify(findByField.name)}, value: String(${refs.findByRef}[${JSON.stringify(findByField.name)}]) }]);
    expect(matches.map((r) => r.id)).toContain(created.id);
  });
`;
}

function renderUpdateBlock(
  updateField: NamedField | null,
  updatedValue: string | null,
  refs: SeedRefs,
): string {
  if (!updateField) return "";
  return `
  it("update modifies the row and returns it", async () => {
    ${refs.seedLine}const created = await service.create(${refs.sampleRef});
    const patch = { ${JSON.stringify(updateField.name)}: ${JSON.stringify(updatedValue)} } as never;
    const updated = await service.update(created.id, patch);
    expect(updated).not.toBeNull();
    expect((updated as unknown as Record<string, unknown>)[${JSON.stringify(updateField.name)}]).toBe(${JSON.stringify(updatedValue)});
  });
`;
}

export function generateGenericServiceIntegrationTest(
  candidate: IntegrationTestCandidate,
  opts: TsGenerateOptions = DEFAULT_GENERATE_OPTIONS,
): GeneratedFile {
  const {
    entityName,
    className,
    tableName,
    sample,
    findByField,
    updateField,
    updatedValue,
    fkSeedPlan,
  } = resolveServiceIntegrationTestSpec(
    candidate,
    opts as IntegrationTestOpts,
  ) as unknown as ResolvedSpec;

  const idKnobs = idKnobsFor(datasourceSettingsFor(opts));
  const servicePath = opts.servicePath ?? DEFAULT_GENERATE_OPTIONS.servicePath;
  const fileBase = namesFor(opts).fileBase(entityName, "service");
  const serviceImport = joinImport(servicePath, fileBase);
  const path = layoutFor(opts).testPath(entityName, "service", {
    fileName: `${fileBase}.integration.test.ts`,
  });
  const repositoriesImport = repositoriesImportFor(opts, fileBase, path);
  const refs = seedRefs(sample, fkSeedPlan, idKnobs);
  const entityRepoOptionsLine = `\n      ${repoOptionsArg(entityName, sample, idKnobs)},`;
  const primaryKeyServiceDecl = renderPrimaryKeyServiceDecl(
    entityName,
    fkSeedPlan,
    idKnobs,
  );
  const findByBlock = renderFindByBlock(findByField, refs);
  const updateBlock = renderUpdateBlock(updateField, updatedValue, refs);

  const content = `import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PrimaryKeyService,
  SqliteDatasource,
  SqliteStandardRepository,
} from "${repositoriesImport}";
import { ${className} } from "${serviceImport}";

const TABLE_NAME = ${JSON.stringify(tableName)};
${primaryKeyServiceDecl}
${refs.moduleDecls}
describe("${className} (sqlite integration)", () => {
  let tmpDir: string;
  let dbPath: string;
  let datasource: SqliteDatasource;
  let service: ${className};
${refs.sampleDecl}
  beforeEach(async () => {
    const prebuilt = process.env.npm_package_config_test_db;
    if (!prebuilt) {
      throw new Error(
        "npm_package_config_test_db is unset — run via \`npm test\` so the pretest hook materializes the prebuilt sqlite via migrate-setup --and-up.",
      );
    }
    tmpDir = await mkdtemp(join(tmpdir(), "${entityName}-itest-"));
    dbPath = join(tmpDir, "test.db");
    await copyFile(prebuilt, dbPath);
    datasource = new SqliteDatasource({
      dbPath,
      pragmas: ["foreign_keys = ON"],
    });
    await datasource.open();
${renderStrip(fkSeedPlan.stripOrder)}
    const repository = new SqliteStandardRepository<${standardRowType(idKnobs)}>(
      datasource,
      TABLE_NAME,${entityRepoOptionsLine}
    );
    service = new ${className}(repository as never${serviceOptionsArg(idKnobs)});
  });

  afterEach(async () => {
    await datasource.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("findAll returns [] on an empty table", async () => {
    expect(await service.findAll()).toEqual([]);
  });

  it("create inserts a row and auto-populates ${idKnobs.withUuidColumn ? "id/uuid/created/updated" : "id/created/updated"}", async () => {
    ${refs.seedLine}const row = await service.create(${refs.sampleRef});
    const r = row as unknown as Record<string, unknown>;
    expect(typeof r.id).toBe("${idKnobs.idTsType}");${idKnobs.withUuidColumn ? '\n    expect(typeof r.uuid).toBe("string");' : ""}
    expect(typeof r.created).toBe("string");
    expect(typeof r.updated).toBe("string");
  });

  it("findById returns the inserted row", async () => {
    ${refs.seedLine}const created = await service.create(${refs.sampleRef});
    const cId = (created as unknown as { id: ${idKnobs.idTsType} }).id;
    const found = await service.findById(cId);
    expect(found).not.toBeNull();
    expect((found as unknown as { id: ${idKnobs.idTsType} }).id).toBe(cId);
  });

  it("findById returns null for a missing id", async () => {
    expect(await service.findById(${idKnobs.missingId})).toBeNull();
  });

  it("findAll lists inserted rows", async () => {
    ${refs.seedLine}await service.create(${refs.sampleRef});
    const rows = await service.findAll();
    expect(rows.length).toBe(1);
  });
${findByBlock}${updateBlock}
  it("update returns null for a missing id", async () => {
    const result = await service.update(${idKnobs.missingId}, {} as never);
    expect(result).toBeNull();
  });

  it("delete removes the row and returns true", async () => {
    ${refs.seedLine}const created = await service.create(${refs.sampleRef});
    const cId = (created as unknown as { id: ${idKnobs.idTsType} }).id;
    expect(await service.delete(cId)).toBe(true);
    expect(await service.findById(cId)).toBeNull();
  });

  it("delete returns false when the row does not exist", async () => {
    expect(await service.delete(${idKnobs.missingId})).toBe(false);
  });
});
`;

  return {
    path,
    content,
  };
}

/** Catalog `service_integration_tests` step (typescript). */
export const generate = (ctx: unknown) =>
  servicesStepGenerate(
    {
      dispatchStep: dispatchServiceIntegrationTestsStep,
      generator: { createGenerator },
      language: "typescript",
    },
    ctx,
  );

export const createGenerator = () => ({
  generate: (config: ServiceTestsGenerateConfig) =>
    generateServiceIntegrationTestsFiles({
      ...config,
      primitives: {
        generateGenericServiceIntegrationTest,
        defaultGenerateOptions: DEFAULT_GENERATE_OPTIONS,
      },
    }),
});
