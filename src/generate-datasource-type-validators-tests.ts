import { toNative } from "./base-type-converter.ts";
import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  datasourceTypesOf,
  TYPES_YAML,
} from "@deterministic-code/generators-common/spec-types";
import {
  DeterministicParser,
  type IDeterministic,
  type Type,
  type TypeField,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import { fieldSize } from "./common/view-shape.ts";
import { typeTestTmpl } from "./resources/datasource-type-validators-tests.ts";
import {
  fakeTestData,
  fieldExpr,
  preludeSource,
  withFakerPackagePatch,
} from "./common/fake-test-data.ts";
import { bag, Emit } from "./emit.ts";

type FieldTok = {
  name: string;
  ident: string;
  sampleExpr: string;
  isNullable: boolean;
  hasDefault: boolean;
  type: string;
};

type CaseTok = {
  name: string;
  fixture: string;
  assertion: string;
};

const MUTABLE_SCALAR = new Set([
  "string",
  "number",
  "boolean",
  "datetime",
  "reference",
  "binary",
]);

const escapeTestName = (name: string): string =>
  name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const objectLiteral = (fields: Array<{ ident: string; expr: string }>): string =>
  `{ ${fields.map((f) => `${f.ident}: ${f.expr}`).join(", ")} }`;

const wrongTypeExpr = (type: string): string | undefined => {
  switch (type) {
    case "string":
      return "123";
    case "number":
    case "reference":
      return `"not-a-number"`;
    case "boolean":
      return `"not-a-boolean"`;
    case "datetime":
      return "42";
    case "binary":
      return `"not-binary"`;
    default:
      return undefined;
  }
};

const fieldTok = (
  field: TypeField | { name: string; type: string; isNullable: boolean },
  fieldIdent: (name: string) => string,
): FieldTok => {
  const ident = fieldIdent(field.name);
  const sampleExpr = fieldExpr(fakeTestData, field.type, {
    nativeType: toNative(field.type),
    size: "size" in field ? fieldSize(field as TypeField) : undefined,
  });
  return {
    name: field.name,
    ident,
    sampleExpr,
    isNullable: field.isNullable,
    hasDefault: "hasDefault" in field && field.hasDefault === true,
    type: field.type,
  };
};

const casesFor = (fields: FieldTok[]): CaseTok[] => {
  const valid = objectLiteral(
    fields.map((f) => ({ ident: f.ident, expr: f.sampleExpr })),
  );
  const cases: CaseTok[] = [
    { name: "parses a valid payload", fixture: valid, assertion: "not.toThrow" },
  ];
  if (fields.some((f) => f.isNullable)) {
    cases.push({
      name: "accepts null for nullable fields",
      fixture: objectLiteral(
        fields.map((f) => ({
          ident: f.ident,
          expr: f.isNullable ? "null" : f.sampleExpr,
        })),
      ),
      assertion: "not.toThrow",
    });
  }
  for (const field of fields) {
    if (!field.isNullable && !field.hasDefault) {
      cases.push({
        name: escapeTestName(`rejects when missing required field "${field.name}"`),
        fixture: objectLiteral(
          fields
            .filter((f) => f.ident !== field.ident)
            .map((f) => ({ ident: f.ident, expr: f.sampleExpr })),
        ),
        assertion: "toThrow",
      });
    }
    if (!field.isNullable) {
      cases.push({
        name: escapeTestName(`rejects when null for non-nullable field "${field.name}"`),
        fixture: objectLiteral(
          fields.map((f) => ({
            ident: f.ident,
            expr: f.ident === field.ident ? "null" : f.sampleExpr,
          })),
        ),
        assertion: "toThrow",
      });
    }
    if (MUTABLE_SCALAR.has(field.type)) {
      const bad = wrongTypeExpr(field.type);
      if (bad !== undefined) {
        cases.push({
          name: escapeTestName(`rejects when wrong type on field "${field.name}"`),
          fixture: objectLiteral(
            fields.map((f) => ({
              ident: f.ident,
              expr: f.ident === field.ident ? bad : f.sampleExpr,
            })),
          ),
          assertion: "toThrow",
        });
      }
    }
  }
  return cases;
};

class Generator extends Emit {
  from(deterministic: IDeterministic): GenerateEntry[] {
    return datasourceTypesOf(deterministic).map((table) => this.tests(table));
  }

  private tests(table: Type): GenerateEntry {
    const fields = table.fields.map((f) =>
      fieldTok(f, (name) => this.casing.fieldIdent(name)),
    );
    const src = this.imports.datasourceValidator(table.name);
    const schemaName = this.casing.schemaName(table.name);
    return content(
      this.imports.test(src, table.name),
      fill(typeTestTmpl, {
        prelude: preludeSource(fakeTestData),
        schemaVersion: this.settings.schemaVersion,
        schemaName,
        tableName: table.name,
        schemaImport: this.imports.testSpec(src, table.name),
        cases: casesFor(fields),
      }),
      bag({
        module: this.imports.validatorTestRel("datasource", table.name),
        imports: this.imports.datasourceValidatorRel(table.name),
        uses: schemaName,
      }),
    );
  }
}

/** Returns attributed entries. Cross-lane validator imports need host `finalizeEntries`. */
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
