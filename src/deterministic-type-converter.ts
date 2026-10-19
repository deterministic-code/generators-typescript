import {
  DeterministicDefaultValueConverter,
  type DefaultEntry,
  type SpecToken,
} from "@deterministic-code/generators-common/deterministic-default-value-converter";
import { DeterministicTypeConverter } from "@deterministic-code/generators-common/deterministic-type-converter";
import {
  EMPTY_UUID,
  hexToBytes,
} from "@deterministic-code/generators-common/default-token";

const spec = DeterministicDefaultValueConverter.spec;

const dq = (value: string): string => JSON.stringify(value);

const token = (
  specToken: SpecToken,
  native: (arg: string) => string,
  reverse: RegExp,
): DefaultEntry => ({ ...specToken, native, reverse });

const quoted = token(spec.string.String!, dq, /^"(.*)"$/);

const exactQuoted = (value: string): RegExp =>
  new RegExp(
    `^${JSON.stringify(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
  );

const numeric = (type: string): Record<string, DefaultEntry> => {
  const numericSpec = spec[type]!.Numeric!;
  return {
    Numeric: token(numericSpec, (arg) => arg, numericSpec.spec),
    String: token(numericSpec, (arg) => arg, numericSpec.spec),
  };
};

export const typeConverter = new DeterministicTypeConverter({
  string: "string",
  character: "string",
  number: "number",
  integer: "number",
  unsignedinteger: "number",
  smallinteger: "number",
  unsignedsmallinteger: "number",
  biginteger: "number",
  unsignedbiginteger: "number",
  float: "number",
  decimal: "string",
  boolean: "boolean",
  datetime: "Date",
  binary: "string",
  uuid: "string",
  reference: "number",
});

export const defaultValueConverter = new DeterministicDefaultValueConverter({
  string: { String: quoted, Numeric: quoted },
  character: { String: quoted, Numeric: quoted },
  number: numeric("number"),
  integer: numeric("integer"),
  unsignedinteger: numeric("unsignedinteger"),
  smallinteger: numeric("smallinteger"),
  unsignedsmallinteger: numeric("unsignedsmallinteger"),
  biginteger: numeric("biginteger"),
  unsignedbiginteger: numeric("unsignedbiginteger"),
  float: numeric("float"),
  decimal: {
    Numeric: token(spec.decimal.Numeric!, dq, /^"(.*)"$/),
    String: quoted,
  },
  boolean: {
    Boolean: token(
      spec.boolean.Boolean!,
      (arg) => (arg === "true" ? "true" : "false"),
      /^(true|false)$/,
    ),
  },
  datetime: {
    Now: token(spec.datetime.Now!, () => "new Date()", /^new Date\(\)$/),
    UtcNow: token(spec.datetime.UtcNow!, () => "new Date()", /^new Date\(\)$/),
    DateTime: token(
      spec.datetime.DateTime!,
      (arg) => `new Date(${dq(arg)})`,
      /^new Date\("(.*)"\)$/,
    ),
  },
  binary: {
    Hex: token(
      spec.binary.Hex!,
      (arg) => {
        const bytes = hexToBytes(arg);
        return bytes.length === 0
          ? '""'
          : `Buffer.from([${bytes.join(", ")}]).toString("base64")`;
      },
      /^.*$/,
    ),
  },
  uuid: {
    NewId: token(
      spec.uuid.NewId!,
      () => "crypto.randomUUID()",
      /^crypto\.randomUUID\(\)$/,
    ),
    Empty: token(spec.uuid.Empty!, () => dq(EMPTY_UUID), exactQuoted(EMPTY_UUID)),
    Uuid: token(spec.uuid.Uuid!, dq, /^"(.*)"$/),
  },
  reference: {},
});

export const toNative = (specType: string): string =>
  typeConverter.convert(specType);

const isTsZeroExpr = (expr: string): boolean =>
  expr === "false" || expr === "0" || expr === '""';

export const collectionDefaultExpr = (field: {
  isArray: boolean;
  isMap?: boolean;
  isNullable: boolean;
  defaultValue?: string | number | boolean | null | readonly [] | object;
}): string | undefined => {
  if (!field.isArray && field.isMap !== true) return undefined;
  if (field.isNullable && field.defaultValue === null) return undefined;
  return field.isMap === true ? "{}" : "[]";
};

/** Native initializer, or `undefined` when absent or the language zero. */
export const nativeDefaultExpr = (
  specType: string,
  field: {
    hasDefault?: boolean;
    defaultValue?: string | number | boolean | null | readonly [] | object;
    isNullable: boolean;
  },
): string | undefined => {
  if (field.hasDefault !== true) return undefined;
  if (
    field.defaultValue === null ||
    Array.isArray(field.defaultValue) ||
    (typeof field.defaultValue === "object" && field.defaultValue !== null)
  ) {
    return undefined;
  }
  const expr = defaultValueConverter.convert(
    specType,
    String(field.defaultValue),
  );
  if (expr === null) return undefined;
  if (field.isNullable) return expr;
  return isTsZeroExpr(expr) ? undefined : expr;
};
