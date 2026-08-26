import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { verifyEntries } from "@deterministic-code/generators-common/reference-verifier";
import {
  datasourceTypesOf,
  TYPES_YAML,
} from "@deterministic-code/generators-common/spec-types";
import {
  DeterministicParser,
  type IDeterministic,
  type Type,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import { idTypeToZod, toZod, toZodDefault } from "./common/type-converters/native-to-zod.ts";
import { fieldSize } from "./common/view-shape.ts";
import { bag, Emit } from "./emit.ts";
import { indexTmpl, typeTmpl } from "./resources/datasource-type-validators.ts";
import type { TypeField } from "@deterministic-code/deterministic-specifications-typescript/parser";

type FieldShape = Pick<
  TypeField,
  | "name"
  | "type"
  | "isNullable"
  | "references"
  | "minSize"
  | "size"
  | "hasDefault"
  | "defaultValue"
>;

const fkTarget = (field: FieldShape): string | undefined => {
  if (field.references === undefined) return undefined;
  return Array.isArray(field.references)
    ? field.references[1]
    : field.references.split(".")[1];
};

const tightenString = (base: string, field: FieldShape): string => {
  let expr = `${base}.trim()`;
  if (field.minSize !== undefined && field.minSize >= 0) {
    expr = `${expr}.min(${field.minSize})`;
  }
  const max = fieldSize(field);
  if (max !== undefined && max >= 0) {
    expr = `${expr}.max(${max})`;
  }
  return expr;
};

const tightenInteger = (
  base: string,
  field: FieldShape,
  { isFk, isIdLike }: { isFk: boolean; isIdLike: boolean },
): string => {
  let expr = `${base}.int()`;
  if (isFk || isIdLike) expr = `${expr}.nonnegative()`;
  if (field.minSize !== undefined) expr = `${expr}.min(${field.minSize})`;
  const max = fieldSize(field);
  if (max !== undefined) expr = `${expr}.max(${max})`;
  return expr;
};

const tightenExpr = (field: FieldShape): string => {
  const base = toZod(field.type);
  const isFk = fkTarget(field) !== undefined;
  const isIdLike = field.name === "id" || field.name.endsWith("_id");

  switch (field.type) {
    case "string":
    case "character":
      return tightenString(base, field);
    case "number":
    case "integer":
    case "biginteger":
    case "smallinteger":
    case "reference":
      return tightenInteger(base, field, { isFk, isIdLike });
    case "float":
      return field.minSize !== undefined
        ? `${base}.min(${field.minSize})`
        : base;
    default:
      return base;
  }
};

const zodForField = (field: FieldShape, useZodId: boolean): string => {
  let expr =
    useZodId || fkTarget(field) === "id"
      ? idTypeToZod(field.type)
      : tightenExpr(field);
  if (field.isNullable) expr = `${expr}.nullable()`;
  if (field.hasDefault) {
    expr = `${expr}.default(${toZodDefault(field.type, field.defaultValue)})`;
  }
  return expr;
};

class Generator extends Emit {
  from(deterministic: IDeterministic): GenerateEntry[] {
    const types = datasourceTypesOf(deterministic);
    const entries = types.map((table) => this.validator(table));
    const index = this.imports.index(
      this.imports.datasourceValidator(types[0]?.name ?? "index"),
    );
    if (index && this.settings.createIndex) {
      entries.push(this.index(types, index));
    }
    return entries;
  }

  private validator(table: Type): GenerateEntry {
    const fields = table.fields.map((field) => ({
      ident: this.casing.fieldIdent(field.name),
      zodExpr: zodForField(field, field.name === "id"),
    }));
    const className = this.casing.convertTypes(table.name);
    const schemaName = this.casing.schemaName(table.name);
    const validatedTypeName = this.casing.validatedTypeName(table.name);
    return content(
      this.imports.datasourceValidator(table.name),
      fill(typeTmpl, {
        schemaVersion: this.settings.schemaVersion,
        schemaName,
        className,
        validatedTypeName,
        withTypeAnnotation: true,
        fields,
      }),
      bag({
        module: this.imports.datasourceValidatorRel(table.name),
        exports: [schemaName, validatedTypeName],
      }),
    );
  }

  private index(
    types: Type[],
    index: string,
  ): GenerateEntry {
    const modules = types.map((t) => this.imports.datasourceValidatorRel(t.name));
    const exports = types.flatMap((t) => [
      this.casing.schemaName(t.name),
      this.casing.validatedTypeName(t.name),
    ]);
    return content(
      index,
      fill(indexTmpl, {
        withTypeAnnotation: true,
        types: types.map((t) => {
          const className = this.casing.convertTypes(t.name);
          return {
            schemaName: this.casing.schemaName(t.name),
            className,
            validatedTypeName: this.casing.validatedTypeName(t.name),
            fileBase: this.casing.fileBase(t.name),
          };
        }),
      }),
      bag({
        module: this.imports
          .datasourceValidatorRel(types[0]?.name ?? "index")
          .replace(/[^/]+$/, "index.ts"),
        exports,
        imports: modules,
        uses: exports,
      }),
    );
  }
}

/** Self-checks references; keeps attributes for host `finalizeEntries` before write. */
export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(TYPES_YAML);
  const entries = new Generator(ctx.settings).from(
    await DeterministicParser(ctx.reader).parse(ctx.settings),
  );
  verifyEntries(entries);
  return entries;
};
