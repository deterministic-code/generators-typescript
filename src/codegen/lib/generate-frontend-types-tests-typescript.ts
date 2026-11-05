import { isWriteDtoViewName } from "../../sdk/lib/schema-build.ts";
import { buildFrontendComponents } from "./frontend-type-components.ts";
import { layoutForSettings } from "../../sdk/codegen/lib/ts-codegen-naming.ts";
import { readBindings, bindingDatasource } from "./frontend-bindings-routes.ts";
import {
  serializeSampleValue as serializeValue,
  accessExpr,
} from "../../sdk/codegen/lib/ts-sample-literal.ts";
import {
  sampleForComponent,
  scalarSetFields,
  nullableFieldNames,
} from "./component-fixture.ts";
import { escapeForTestName } from "./zod-test-cases.ts";
import { CONTENT } from "../../sdk/codegen/lib/generate-result.ts";
import { frontendTestHarnessPatch } from "./frontend-test-harness.ts";
import type { GenerateArgs } from "./frontend-generate-types.ts";
import type { CodegenNames } from "../../sdk/codegen-naming.ts";
import type { CodegenLayout } from "../../sdk/codegen-layout.ts";

type Components = Record<string, unknown>;

interface TestOpts {
  names: CodegenNames;
  ident: (key: string) => string;
  datetime: string;
}

type TestCtx = TestOpts & { layout: CodegenLayout; datasource: string };

interface TestModel {
  readNames: string[];
  components: Components;
  opts: TestOpts;
  layout: CodegenLayout;
}

function constructsCase(className: string, fixtureLiteral: string): string {
  return [
    `  it("constructs a valid ${className}", () => {`,
    `    const value: ${className} = ${fixtureLiteral};`,
    `    expect(value).toBeDefined();`,
    `  });`,
  ].join("\n");
}

function accessorCase(
  className: string,
  fixtureLiteral: string,
  { key, next }: { key: string; next: unknown },
): string {
  const access = accessExpr(key);
  return [
    `  it("gets and sets ${escapeForTestName(key)}", () => {`,
    `    const value: ${className} = ${fixtureLiteral};`,
    `    const next = ${serializeValue(next)};`,
    `    value${access} = next;`,
    `    expect(value${access}).toEqual(next);`,
    `  });`,
  ].join("\n");
}

function nullableCase(
  className: string,
  fixtureLiteral: string,
  key: string,
): string {
  const access = accessExpr(key);
  return [
    `  it("allows setting ${escapeForTestName(key)} to null", () => {`,
    `    const value: ${className} = ${fixtureLiteral};`,
    `    value${access} = null;`,
    `    expect(value${access}).toBeNull();`,
    `  });`,
  ].join("\n");
}

function testFileContents(
  name: string,
  components: Components,
  opts: TestCtx,
): string {
  const className = opts.names.className(name);
  const fixtureLiteral = serializeValue(
    sampleForComponent(name, components, {
      datetime: opts.datetime,
      ident: opts.ident,
    }),
  );
  const cases = [constructsCase(className, fixtureLiteral)];
  for (const field of scalarSetFields(name, components, {
    ident: opts.ident,
  })) {
    cases.push(accessorCase(className, fixtureLiteral, field));
  }
  for (const key of nullableFieldNames(name, components, {
    ident: opts.ident,
  })) {
    cases.push(nullableCase(className, fixtureLiteral, key));
  }
  const stem = opts.names.casedFileStem(name);
  const testFile = opts.layout.frontendTypesFile(
    opts.datasource,
    `${stem}.test.ts`,
  );
  const typeFile = opts.layout.frontendTypesFile(opts.datasource, `${stem}.ts`);
  const header = [
    `import { describe, it, expect } from "vitest";`,
    `import type { ${className} } from "${opts.layout.frontendRelImport(testFile, typeFile)}";`,
  ].join("\n");
  return `${header}\n\ndescribe("${className} (frontend types)", () => {\n${cases.join("\n\n")}\n});\n`;
}

function datasourceTestEntries(
  datasource: string,
  { readNames, components, opts, layout }: TestModel,
) {
  const ctx: TestCtx = { ...opts, layout, datasource };
  return readNames.map((name) => ({
    kind: CONTENT,
    filename: layout.frontendTypesFile(
      datasource,
      `${opts.names.casedFileStem(name)}.test.ts`,
    ),
    contents: testFileContents(name, components, ctx),
  }));
}

/** Generate a `<stem>.test.ts` next to every read type frontend_types generates — under `bindings/<datasource>/types/` for each `frontend_bindings.yaml` datasource, the same entity/view components filtered to read types the same way. Each test constructs a fully-typed instance (a compile-time shape check against the generated interface) and exercises get/set on its plain scalar fields plus null-assignment on its nullable ones. Adds the vitest harness to frontend/package.json. */
export async function generate({ inputs, settings }: GenerateArgs) {
  const { datasources } = await readBindings(inputs);
  if (datasources.length === 0) return { entries: [] };
  const { components, names, fields, datetime } = await buildFrontendComponents(
    { inputs, settings },
  );
  const layout = layoutForSettings(settings, "typescript");
  const opts: TestOpts = {
    names,
    ident: (key: string) => fields.ident(key),
    datetime,
  };
  const readNames = Object.keys(components)
    .filter((name) => !isWriteDtoViewName(name))
    .sort((a, b) => names.className(a).localeCompare(names.className(b)));
  const model: TestModel = {
    readNames,
    components: components as Components,
    opts,
    layout,
  };
  const entries = [];
  for (const entry of datasources) {
    const ds = bindingDatasource(entry);
    entries.push(...datasourceTestEntries(ds.name, model));
  }
  if (entries.length > 0) entries.push(frontendTestHarnessPatch());
  return { entries };
}

export const entriesNative = true;

export const assembleAfterStep = true;
