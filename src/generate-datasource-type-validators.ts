import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  DeterministicParser,
  type IDeterministic,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import {
  DATASOURCE_TYPES_YAML,
  type DatasourceType,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import { idTypeToZod, toZod, toZodDefault } from "./common/type-converters/native-to-zod.ts";
import { Emit } from "./emit.ts";
import { indexTmpl, typeTmpl } from "./resources/datasource-type-validators.ts";

type FieldShape = {
  name: string;
  type: string;
  isNullable: boolean;
  references?: string;
  minSize?: number;
  size?: number;
  hasDefault?: boolean;
  defaultValue?: string | number | boolean | null;
};

const tightenString = (base: string, field: FieldShape): string => {
  let expr = `${base}.trim()`;
  if (field.minSize !== undefined && field.minSize >= 0) {
    expr = `${expr}.min(${field.minSize})`;
  }
  if (field.size !== undefined && field.size >= 0) {
    expr = `${expr}.max(${field.size})`;
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
  if (field.size !== undefined) expr = `${expr}.max(${field.size})`;
  return expr;
};

const tightenExpr = (field: FieldShape): string => {
  const base = toZod(field.type);
  const isFk =
    typeof field.references === "string" && field.references.length > 0;
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
    useZodId || field.references?.split(".")[1] === "id"
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
    const types = deterministic.expandedDatasourceTypes;
    const entries = types.map((table) => this.validator(table));
    const index = this.imports.index(
      this.imports.datasourceValidator(types[0]?.name ?? "index"),
    );
    if (index && this.settings.createIndex) {
      entries.push(this.index(types, index));
    }
    return entries;
  }

  private validator(table: DatasourceType): GenerateEntry {
    const fields = table.fields.map((field) => ({
      ident: this.casing.fieldIdent(field.name),
      zodExpr: zodForField(field, field.name === "id"),
    }));
    const className = this.casing.convertTypes(table.name);
    return content(
      this.imports.datasourceValidator(table.name),
      fill(typeTmpl, {
        schemaVersion: this.settings.schemaVersion,
        schemaName: this.casing.schemaName(table.name),
        className,
        validatedTypeName: this.casing.validatedTypeName(table.name),
        withTypeAnnotation: true,
        fields,
      }),
    );
  }

  private index(
    types: DatasourceType[],
    index: string,
  ): GenerateEntry {
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
    );
  }
}

export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(DATASOURCE_TYPES_YAML);
  return new Generator(ctx.settings).from(
    await DeterministicParser(ctx.reader).parse(ctx.settings),
  );
};
