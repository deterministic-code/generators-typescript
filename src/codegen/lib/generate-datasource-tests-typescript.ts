import { toCase } from "../../sdk/case.ts";
import { datasourceTestsModule } from "../../sdk/codegen/lib/generate-settings-options.ts";
import {
  layoutFor,
  namesFor,
  type NamesForOptions,
} from "../../sdk/codegen/lib/ts-codegen-naming.ts";
import {
  buildDatasourceFixture,
  enumerateInvalidMutations,
} from "../../sdk/codegen/lib/fixture-builder.ts";
import { serializeSampleValue as serializeValue } from "../../sdk/codegen/lib/ts-sample-literal.ts";
import { renderFieldAccessorCases } from "./ts-accessor-cases.ts";
import {
  cloneFixture,
  renderMutationCase,
  renderNullableVariantCase,
  renderValidCase,
} from "./zod-test-cases.ts";

type Flatten<T> = { [K in keyof T]: T[K] };

export type GenerateOptions = Flatten<
  NamesForOptions & {
    schemaVersion: string;
    validatorPath: string;
    typePath: string;
    datetime?: string;
    idType?: string;
  }
>;

interface TsFieldDef {
  is_nullable?: boolean;
}

interface TsTableDef {
  fields?: Array<Record<string, TsFieldDef>>;
}

interface Mutation {
  description: string;
  mutate: (fixture: Record<string, unknown>) => Record<string, unknown>;
}

export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  schemaVersion: "1.0",
  validatorPath: "../validators",
  typePath: "..",
};

function fileBase(name: string, opts: GenerateOptions): string {
  return namesFor(opts).fileBase(name, "datasource-type");
}

function schemaIdent(name: string): string {
  return `${toCase(name, "Camel")}Schema`; // lint-generator-casing-allow: toCase
}

function joinImport(base: string, file: string): string {
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return `${normalized}${file}`;
}

function importsBlock(tableName: string, opts: GenerateOptions): string {
  const schemaName = schemaIdent(tableName);
  const className = namesFor(opts).className(tableName);
  const file = fileBase(tableName, opts);
  const layout = layoutFor(opts);
  const schemaImport = layout.testImportSpecifier(
    { entity: tableName, artifact: "datasource-type" },
    { entity: tableName, artifact: "datasource-validator" },
    { flat: joinImport(opts.validatorPath, file) },
  );
  const typeImport = layout.testImportSpecifier(
    { entity: tableName, artifact: "datasource-type" },
    { entity: tableName, artifact: "datasource-type" },
    { flat: joinImport(opts.typePath, file) },
  );
  return [
    `import { describe, it, expect } from "vitest";`,
    `import type { ${className} } from "${typeImport}";`,
    `import { ${schemaName} } from "${schemaImport}";`,
  ].join("\n");
}

function hasAnyNullable(tableDef: TsTableDef): boolean {
  return (tableDef.fields ?? []).some((f) => {
    const fdef = Object.values(f)[0];
    return fdef.is_nullable === true;
  });
}

function nullableFieldNames(tableDef: TsTableDef): Set<string> {
  const names = new Set<string>();
  for (const f of tableDef.fields ?? []) {
    const [fname, fdef] = Object.entries(f)[0];
    if (fdef.is_nullable === true) names.add(fname);
  }
  return names;
}

function renderAccessorCases(args: {
  tableName: string;
  tableDef: TsTableDef;
  datasource: unknown;
  opts: GenerateOptions;
}): { className: string; cases: string[] } {
  const { tableName, tableDef, datasource, opts } = args;
  const className = namesFor(opts).className(tableName);
  const fixture = buildDatasourceFixture({
    table: tableName,
    datasource,
    datetime: opts.datetime,
    idType: opts.idType,
  });
  const entries = Object.entries(fixture);
  if (entries.length === 0) return { className, cases: [] };

  const serializedFixture = serializeValue(fixture);
  const cases: string[] = renderFieldAccessorCases({
    className,
    serializedFixture,
    entries,
    nullableNames: nullableFieldNames(tableDef),
  });

  return { className, cases };
}

export function generateForTable(
  entry: Record<string, TsTableDef>,
  datasource: unknown,
  options: Partial<GenerateOptions> = DEFAULT_GENERATE_OPTIONS,
): { path: string; content: string } {
  const opts: GenerateOptions = { ...DEFAULT_GENERATE_OPTIONS, ...options };
  const [tableName, tableDef] = Object.entries(entry)[0];
  const schemaName = schemaIdent(tableName);
  const path = layoutFor(opts).testPath(tableName, "datasource-type", {
    fileName: `${fileBase(tableName, opts)}.test.ts`,
  });

  const validFixture = buildDatasourceFixture({
    table: tableName,
    datasource,
    datetime: opts.datetime,
    idType: opts.idType,
  });
  const cases = [renderValidCase(schemaName, validFixture)];

  if (hasAnyNullable(tableDef)) {
    const nullableFixture = buildDatasourceFixture({
      table: tableName,
      datasource,
      nullableVariant: true,
      datetime: opts.datetime,
      idType: opts.idType,
    });
    cases.push(renderNullableVariantCase(schemaName, nullableFixture));
  }

  const mutations: Mutation[] = enumerateInvalidMutations({
    table: tableName,
    datasource,
  });
  for (const m of mutations) {
    const mutated = m.mutate(
      cloneFixture(validFixture as Record<string, unknown>),
    );
    cases.push(renderMutationCase(schemaName, m.description, mutated));
  }

  const header = `// schema-version: ${opts.schemaVersion}\n${importsBlock(tableName, opts)}\n\n`;
  const validatorBody = `describe("${schemaName} (datasource_types.${tableName})", () => {\n${cases.join("\n\n")}\n});\n`;

  const accessor = renderAccessorCases({
    tableName,
    tableDef,
    datasource,
    opts,
  });
  let accessorBody = "";
  if (accessor.cases.length > 0) {
    accessorBody = `\ndescribe("${accessor.className} field accessors (datasource_types.${tableName})", () => {\n${accessor.cases.join("\n\n")}\n});\n`;
  }

  return {
    path,
    content: `${header}${validatorBody}${accessorBody}`,
  };
}

export const { generateFromSchema, createGenerator } = datasourceTestsModule({
  generateForTable,
  defaultGenerateOptions: DEFAULT_GENERATE_OPTIONS,
});
