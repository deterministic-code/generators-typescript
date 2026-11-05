import type { ParsedSettings } from "../../sdk/read-settings.ts";
import { toCase } from "../../sdk/case.ts";
import { testCasingOptionsFromSettings } from "../../sdk/codegen/lib/generate-settings-options.ts";
import {
  layoutFor,
  namesFor,
  type NamesForOptions,
} from "../../sdk/codegen/lib/ts-codegen-naming.ts";
import { normalizeAll } from "../../sdk/view-expand.ts";
import type { RawTypesDoc } from "../../sdk/deterministic-shapes.ts";
import { viewGenerator } from "../../sdk/codegen-context.ts";
import { TypescriptImports } from "./typescript-imports.ts";
import {
  buildViewFixture,
  enumerateInvalidMutations,
} from "../../sdk/codegen/lib/fixture-builder.ts";
import { serializeSampleValue as serializeValue } from "../../sdk/codegen/lib/ts-sample-literal.ts";
import { renderFieldAccessorCases } from "./ts-accessor-cases.ts";
import { joinImport } from "./library-import.ts";
import type {
  Datasource,
  DatasourceTypeDef,
  ShapedView,
  UnionView,
  View,
} from "../../sdk/codegen/lib/generate-view-shared.ts";

type Flatten<T> = { [K in keyof T]: T[K] };

export type GenerateOptions = Flatten<
  NamesForOptions & {
    schemaVersion: string;
    viewPath: string;
    schemaPath: string;
    datetime?: string;
    idType?: string;
  }
>;

interface Mutation {
  description: string;
  mutate: (fixture: Record<string, unknown>) => Record<string, unknown>;
}

interface UnionMemberFixture {
  memberName: string;
  fixture: Record<string, unknown>;
}

interface GeneratedFile {
  path: string;
  content: string;
}

interface ShapedRenderArgs {
  view: ShapedView;
  viewTypes: unknown;
  datasource: Datasource;
  opts: GenerateOptions;
}

export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  schemaVersion: "1.0",
  viewPath: "..",
  schemaPath: "../validators",
};

function fileBase(name: string, opts: GenerateOptions): string {
  return namesFor(opts).fileBase(name, "view-type");
}

function viewSchemaIdent(name: string): string {
  return `${toCase(name, "Camel")}Schema`; // lint-generator-casing-allow: toCase
}

function importsBlock(
  viewName: string,
  opts: GenerateOptions,
  { withTypeImport }: { withTypeImport?: boolean } = { withTypeImport: false },
): string {
  const schemaName = viewSchemaIdent(viewName);
  const file = fileBase(viewName, opts);
  const schemaImportPath = layoutFor(opts).testImportSpecifier(
    { entity: viewName, artifact: "view-type" },
    { entity: viewName, artifact: "view-validator" },
    {
      flat: joinImport(opts.schemaPath, file),
    },
  );
  const lines = [`import { describe, it, expect } from "vitest";`];
  if (withTypeImport) {
    const className = namesFor(opts).className(viewName);
    const viewImportPath = layoutFor(opts).testImportSpecifier(
      { entity: viewName, artifact: "view-type" },
      { entity: viewName, artifact: "view-type" },
      {
        flat: joinImport(opts.viewPath, file),
      },
    );
    lines.push(`import type { ${className} } from "${viewImportPath}";`);
  }
  lines.push(`import { ${schemaName} } from "${schemaImportPath}";`);
  return lines.join("\n");
}

function collectNullableFieldNames(
  view: ShapedView,
  datasource: Datasource,
): Set<string> {
  const names = new Set<string>();
  for (const f of view.fields) {
    if (f.isNullable) names.add(f.name);
  }
  if (view.inherits) {
    const entry = (datasource.types ?? []).find(
      (e) => Object.keys(e)[0] === view.inherits,
    );
    if (entry) {
      const def = Object.values(entry)[0];
      for (const f of def.fields ?? []) {
        const [fname, fdef] = Object.entries(f)[0];
        if (fdef.is_nullable === true) names.add(fname);
      }
    }
  }
  return names;
}

function renderAccessorCases({
  view,
  viewTypes,
  datasource,
  opts,
}: ShapedRenderArgs): { cases: string[]; className: string } {
  const validFixture = buildViewFixture({
    view: view.name,
    viewTypes,
    datasource,
    datetime: opts.datetime,
    idType: opts.idType,
  }) as Record<string, unknown>;
  const className = namesFor(opts).className(view.name);
  const entries = Object.entries(validFixture);
  if (entries.length === 0) return { cases: [], className };

  const serializedFixture = serializeValue(validFixture);
  const cases: string[] = renderFieldAccessorCases({
    className,
    serializedFixture,
    entries,
    nullableNames: collectNullableFieldNames(view, datasource),
  });

  return { cases, className };
}

function escapeForTestName(s: string): string {
  return s.replace(/"/g, '\\"');
}

/** Only deep-clone plain objects; RuntimeValue/RawTsExpr/Date markers are immutable and must keep their prototype so the serializer still recognizes them. */
function cloneDeep(value: unknown): unknown {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(cloneDeep);
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = cloneDeep(v);
    return out;
  }
  return value;
}

function anyNullableOnInherited(
  tableName: string,
  datasource: Datasource,
): boolean {
  const entry = (datasource.types ?? []).find(
    (e) => Object.keys(e)[0] === tableName,
  );
  const def = Object.values(entry as Record<string, DatasourceTypeDef>)[0];
  return (def.fields ?? []).some(
    (f) => Object.values(f)[0].is_nullable === true,
  );
}

function parseCase({
  schemaName,
  name,
  value,
  assertion,
}: {
  schemaName: string;
  name: string;
  value: unknown;
  assertion: string;
}): string {
  return [
    `  it("${name}", () => {`,
    `    const value = ${serializeValue(value)};`,
    `    expect(() => ${schemaName}.parse(value)).${assertion}();`,
    `  });`,
  ].join("\n");
}

function shapedValidatorCases({
  view,
  viewTypes,
  datasource,
  opts,
}: ShapedRenderArgs): string[] {
  const schemaName = viewSchemaIdent(view.name);
  const fixtureBase = {
    view: view.name,
    viewTypes,
    datasource,
    datetime: opts.datetime,
    idType: opts.idType,
  };
  const validFixture = buildViewFixture(fixtureBase);
  const cases: string[] = [
    parseCase({
      schemaName,
      name: "parses a valid payload",
      value: validFixture,
      assertion: "not.toThrow",
    }),
  ];

  const hasNullable =
    view.fields.some((f) => f.isNullable) ||
    Boolean(view.inherits && anyNullableOnInherited(view.inherits, datasource));
  if (hasNullable) {
    const nullableFixture = buildViewFixture({
      ...fixtureBase,
      nullableVariant: true,
    });
    cases.push(
      parseCase({
        schemaName,
        name: "accepts null for nullable fields",
        value: nullableFixture,
        assertion: "not.toThrow",
      }),
    );
  }

  const mutations: Mutation[] = enumerateInvalidMutations({
    view: view.name,
    viewTypes,
    datasource,
  });
  for (const m of mutations) {
    const mutated = m.mutate(
      cloneDeep(validFixture) as Record<string, unknown>,
    );
    cases.push(
      parseCase({
        schemaName,
        name: `rejects when ${escapeForTestName(m.description)}`,
        value: mutated,
        assertion: "toThrow",
      }),
    );
  }

  return cases;
}

function renderShapedView(args: ShapedRenderArgs): GeneratedFile {
  const { view, opts } = args;
  const schemaName = viewSchemaIdent(view.name);
  const cases = shapedValidatorCases(args);

  const header = `// schema-version: ${opts.schemaVersion}\n${importsBlock(view.name, opts, { withTypeImport: true })}\n\n`;
  const validatorBody = `describe("${schemaName} (view_types.${view.name})", () => {\n${cases.join("\n\n")}\n});\n`;

  const accessor = renderAccessorCases(args);
  let accessorBody = "";
  if (accessor && accessor.cases.length > 0) {
    accessorBody = `\ndescribe("${accessor.className} field accessors (view_types.${view.name})", () => {\n${accessor.cases.join("\n\n")}\n});\n`;
  }

  return {
    path: `${fileBase(view.name, opts)}.test.ts`,
    content: `${header}${validatorBody}${accessorBody}`,
  };
}

function renderUnionView({
  view,
  viewTypes,
  datasource,
  opts,
}: {
  view: UnionView;
  viewTypes: unknown;
  datasource: Datasource;
  opts: GenerateOptions;
}): GeneratedFile {
  const schemaName = viewSchemaIdent(view.name);
  const cases: string[] = [];

  const members = buildViewFixture({
    view: view.name,
    viewTypes,
    datasource,
    allMembers: true,
    datetime: opts.datetime,
    idType: opts.idType,
  }) as UnionMemberFixture[];

  for (const { memberName, fixture } of members) {
    cases.push(
      [
        `  it("accepts a ${memberName} member", () => {`,
        `    const value = ${serializeValue(fixture)};`,
        `    expect(() => ${schemaName}.parse(value)).not.toThrow();`,
        `  });`,
      ].join("\n"),
    );
  }

  cases.push(
    [
      `  it("rejects a shape that matches neither member", () => {`,
      `    const value = { __not_a_member__: true };`,
      `    expect(() => ${schemaName}.parse(value)).toThrow();`,
      `  });`,
    ].join("\n"),
  );

  const header = `// schema-version: ${opts.schemaVersion}\n${importsBlock(view.name, opts, { withTypeImport: false })}\n\n`;
  const body = `describe("${schemaName} (view_types.${view.name})", () => {\n${cases.join("\n\n")}\n});\n`;
  return {
    path: `${fileBase(view.name, opts)}.test.ts`,
    content: `${header}${body}`,
  };
}

export function generateForView({
  view,
  viewTypes,
  datasource,
  options = DEFAULT_GENERATE_OPTIONS,
}: {
  view: View;
  viewTypes: unknown;
  datasource: Datasource;
  options?: Partial<GenerateOptions>;
}): GeneratedFile {
  const opts: GenerateOptions = { ...DEFAULT_GENERATE_OPTIONS, ...options };
  if (view.kind === "union") {
    return renderUnionView({ view, viewTypes, datasource, opts });
  }
  return renderShapedView({ view, viewTypes, datasource, opts });
}

export function generateFromSchema(
  { viewTypes, datasource }: { viewTypes: unknown; datasource: Datasource },
  options: Partial<GenerateOptions> = DEFAULT_GENERATE_OPTIONS,
): GeneratedFile[] {
  const opts: GenerateOptions = { ...DEFAULT_GENERATE_OPTIONS, ...options };
  const normalized = normalizeAll(viewTypes as RawTypesDoc) as View[];
  return normalized.map((v) =>
    generateForView({ view: v, viewTypes, datasource, options: opts }),
  );
}

const baseCreateGenerator = viewGenerator((view, ctx) => {
  const file = generateForView({
    view,
    viewTypes: ctx.opts.viewTypes,
    datasource: ctx.opts.datasourceTypes,
    options: ctx.opts,
  });
  if (!ctx.byFeature) return file;
  const stem = `${ctx.names.fileBase(view.name, "view-type")}${ctx.names.bfRoleExt("view-type")}`;
  return {
    ...file,
    path: ctx.layout.testPath(view.name, "view-type", {
      fileName: `${stem}.test.ts`,
    }),
  };
});

export const createGenerator = () => {
  const base = baseCreateGenerator(TypescriptImports);
  return {
    generate: (config: { settings: ParsedSettings; language: string }) =>
      base.generate({
        ...DEFAULT_GENERATE_OPTIONS,
        ...testCasingOptionsFromSettings(config),
        ...config,
      }),
  };
};
