import {
  DeterministicDefaultValueConverter,
  type DefaultEntry,
  type SpecToken,
} from "@deterministic-code/generators-common/deterministic-default-value-converter";
import { DeterministicTypeConverter } from "@deterministic-code/generators-common/deterministic-type-converter";
import {
  EMPTY_UUID,
  GENERATIVE_TOKENS,
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

const numeric = (type: string): Record<string, DefaultEntry> => {
  const numericSpec = spec[type]!.Numeric!;
  return {
    Numeric: token(numericSpec, (arg) => arg, numericSpec.spec),
    String: token(numericSpec, (arg) => arg, numericSpec.spec),
  };
};

export const typeConverter = new DeterministicTypeConverter({
  string: "z.string()",
  character: "z.string()",
  decimal: "z.string()",
  number: "z.number()",
  integer: "z.number()",
  smallinteger: "z.number()",
  unsignedinteger: "z.number()",
  unsignedsmallinteger: "z.number()",
  float: "z.number()",
  reference: "z.number()",
  biginteger: "z.number()",
  unsignedbiginteger: "z.number()",
  boolean: "z.boolean()",
  binary: "z.string().base64()",
  uuid: "z.string().uuid()",
  datetime: "z.date()",
});

const hexNative = (arg: string): string => {
  const bytes = hexToBytes(arg);
  return bytes.length === 0
    ? '""'
    : `Buffer.from([${bytes.join(", ")}]).toString("base64")`;
};

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
    Hex: token(spec.binary.Hex!, hexNative, /^.*$/),
  },
  uuid: {
    NewId: token(
      spec.uuid.NewId!,
      () => "crypto.randomUUID()",
      /^crypto\.randomUUID\(\)$/,
    ),
    Empty: token(
      spec.uuid.Empty!,
      () => dq(EMPTY_UUID),
      new RegExp(
        `^${JSON.stringify(EMPTY_UUID).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      ),
    ),
    Uuid: token(spec.uuid.Uuid!, dq, /^"(.*)"$/),
  },
  reference: {},
});

const ID_ZOD: Record<string, string> = {
  integer: "z.number().int().nonnegative()",
  biginteger: "z.bigint()",
  uuid: "z.string().uuid()",
  string: "z.string()",
};

export const toZod = (specType: string): string =>
  typeConverter.convert(specType);

export const idTypeToZod = (idType: string): string =>
  ID_ZOD[idType] ?? ID_ZOD.integer;

/** JS expression for a spec field's `{ type, value }` default — `"null"` when absent. */
export const toZodDefault = (
  type: string,
  value: string | boolean | number | null | undefined | object,
): string => {
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  if (value === undefined || value === null) return "null";
  const parsed = DeterministicDefaultValueConverter.parse(type, value);
  const literal = defaultValueConverter.convert(type, String(value));
  if (literal === null) {
    throw new Error(`cannot render default token "${parsed.token}"`);
  }
  return GENERATIVE_TOKENS.has(parsed.token) ? `() => ${literal}` : literal;
};
