import {
  EMPTY_UUID,
  GENERATIVE_TOKENS,
  hexToBytes,
  parseDefaultToken,
} from "@deterministic-code/generators-common/default-token";

/** Spec field type → base Zod expression (before size/nullability tighteners). */
const ZOD: Record<string, string> = {
  string: "z.string()",
  character: "z.string()",
  decimal: "z.string()",
  number: "z.number()",
  integer: "z.number()",
  smallinteger: "z.number()",
  float: "z.number()",
  reference: "z.number()",
  biginteger: "z.number()",
  boolean: "z.boolean()",
  binary: "z.string().base64()",
  uuid: "z.string().uuid()",
  datetime: "z.date()",
};

/** Spec PK / FK-to-id field type → Zod id expression. */
const ID_ZOD: Record<string, string> = {
  integer: "z.number().int().nonnegative()",
  biginteger: "z.bigint()",
  uuid: "z.string().uuid()",
  string: "z.string()",
};

type DefaultArg = string | boolean | undefined;

const dq = (value: DefaultArg): string => JSON.stringify(String(value));

/** Default-token renderers: datasource_type token → JS expression for `.default(...)`. */
const ZOD_DEFAULT: Record<string, (arg?: DefaultArg) => string> = {
  NewId: () => "crypto.randomUUID()",
  Empty: () => dq(EMPTY_UUID),
  Uuid: (a) => dq(a),
  DateTime: (a) => (a === undefined ? "new Date()" : `new Date(${dq(a)})`),
  Now: () => "new Date()",
  UtcNow: () => "new Date()",
  Hex: (a) => {
    const bytes = hexToBytes(a as string);
    return bytes.length === 0
      ? '""'
      : `Buffer.from([${bytes.join(", ")}]).toString("base64")`;
  },
  Boolean: (a) => (a ? "true" : "false"),
  Numeric: (a) => a as string,
  String: (a) => dq(a),
};

export const toZod = (specType: string): string => {
  const expr = ZOD[specType];
  if (expr === undefined) {
    throw new Error(`Unknown datasource field type: ${specType}`);
  }
  return expr;
};

export const idTypeToZod = (idType: string): string =>
  ID_ZOD[idType] ?? ID_ZOD.integer;

/** JS expression for a spec field's `{ type, value }` default — `"null"` when absent. */
export const toZodDefault = (
  type: string,
  value: string | boolean | number | null | undefined | object,
): string => {
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  const parsed = parseDefaultToken(type, value);
  if (parsed.token === "None") return "null";
  const render =
    type === "decimal" ? ZOD_DEFAULT.String : ZOD_DEFAULT[parsed.token];
  if (!render) {
    throw new Error(`cannot render default token "${parsed.token}"`);
  }
  const literal = render(parsed.arg);
  return GENERATIVE_TOKENS.has(parsed.token) ? `() => ${literal}` : literal;
};
