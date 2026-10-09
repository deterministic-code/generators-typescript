import { toNative } from "./base-type-converter.ts";
import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  datasourceTypesOf,
  fieldTypeOf,
  persistedColumnFields,
  TYPES_YAML,
} from "@deterministic-code/generators-common/spec-types";
import {
  DeterministicParser,
  type IDeterministic,
  type Type,
  type TypeField,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import { fieldSize } from "./common/view-shape.ts";
import { typeTestTmpl } from "./resources/datasource-types-tests.ts";
import {
  fakeTestData,
  fieldExpr,
  preludeSource,
  withFakerPackagePatch,
} from "./common/fake-test-data.ts";
import { bag, Emit } from "./emit.ts";

const escapeTestName = (name: string): string =>
  name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const fieldTokens = (
  field: TypeField,
  fieldIdent: (name: string) => string,
  typesByName: ReadonlyMap<string, Type>,
) => {
  const ident = fieldIdent(field.name);
  const specType = fieldTypeOf(field, typesByName);
  const expr = fieldExpr(fakeTestData, specType, {
    nativeType: toNative(specType),
    size: fieldSize(field),
  });
  return {
    ident,
    access: ident.startsWith('"') ? `[${ident}]` : `.${ident}`,
    testName: escapeTestName(field.name),
    sampleExpr: expr,
    nextExpr: expr,
    nullable: field.isNullable,
  };
};

class Generator extends Emit {
  from(deterministic: IDeterministic): GenerateEntry[] {
    const typesByName = new Map(
      deterministic.expandedTypes.map((t) => [t.name, t]),
    );
    return datasourceTypesOf(deterministic).map((table) =>
      this.tests(table, typesByName),
    );
  }

  private tests(table: Type, typesByName: Map<string, Type>): GenerateEntry {
    const fields = persistedColumnFields(table, typesByName).map((f) =>
      fieldTokens(f, (name) => this.casing.fieldIdent(name), typesByName),
    );
    const src = this.imports.datasource(table.name);
    const className = this.casing.convertTypes(table.name);
    return content(
      this.imports.test(src, table.name),
      fill(typeTestTmpl, {
        prelude: preludeSource(fakeTestData),
        schemaVersion: this.settings.schemaVersion,
        className,
        tableName: table.name,
        typeImport: this.imports.testSpec(src, table.name),
        fixture: `{ ${fields.map((f) => `${f.ident}: ${f.sampleExpr}`).join(", ")} }`,
        fields,
      }),
      bag({
        module: this.imports.datasourceTestRel(table.name),
        imports: this.imports.datasourceRel(table.name),
        uses: className,
      }),
    );
  }
}

/** Returns attributed entries. Cross-lane type imports need host `finalizeEntries`. */
export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(TYPES_YAML);
  return withFakerPackagePatch(
    new Generator(ctx.settings).from(
      await DeterministicParser(ctx.reader).parse(ctx.settings),
    ),
  );
};
