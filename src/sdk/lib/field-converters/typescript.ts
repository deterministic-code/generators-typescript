import { dq, hexToBytes, type ConverterModule } from "./base.ts";
import { EMPTY_UUID } from "../default-token.ts";

/** The base64 sample a `binary` field takes on the TypeScript wire — binary is carried as a base64 string in a `format: byte` body, so the sampler generates a base64 string literal, not an `ArrayBuffer`. The canonical home; `ts-sample-literal.ts` re-exports it. */
export const SAMPLE_BINARY_BASE64 = "AAAAAAAAAAAAAAAAAAAAAA==";

/** TypeScript field converter: datasource_type → TS type + default-token literal/expression. */
export default {
  target: "typescript",
  targetKind: "language",
  datetimeStringType: "string",
  datetimeStringDefault: "new Date().toISOString()",
  conversions: [
    { type: "string", native: "string" },
    { type: "character", native: "string" },
    { type: "number", native: "number" },
    { type: "integer", native: "number" },
    { type: "smallinteger", native: "number" },
    { type: "biginteger", native: "number" },
    { type: "unsignedinteger", native: "number" },
    { type: "unsignedsmallinteger", native: "number" },
    { type: "unsignedbiginteger", native: "number" },
    { type: "float", native: "number" },
    { type: "decimal", native: "string" },
    { type: "boolean", native: "boolean" },
    { type: "datetime", native: "Date" },
    { type: "binary", native: "string" },
    { type: "uuid", native: "string" },
    { type: "reference", native: "number" },
  ],
  defaults: {
    Now: () => "new Date()",
    UtcNow: () => "new Date()",
    NewId: () => "crypto.randomUUID()",
    Empty: () => dq(EMPTY_UUID),
    Uuid: (a) => dq(a),
    DateTime: (a) => `new Date(${dq(a)})`,
    Hex: (a) =>
      `new Uint8Array([${hexToBytes(a as string).join(", ")}]).buffer`,
    Boolean: (a) => (a ? "true" : "false"),
    Numeric: (a) => a as string,
    String: (a) => dq(a),
  },
  newIdSample: () => "crypto.randomUUID()",
  newStringSample: (max) =>
    typeof max === "number" && Number.isFinite(max)
      ? `crypto.randomUUID().slice(0, ${max})`
      : "crypto.randomUUID()",
  jsonSample: {
    string: `"sample"`,
    character: `"sample"`,
    uuid: dq(EMPTY_UUID),
    number: "1",
    integer: "1",
    smallinteger: "1",
    biginteger: "1",
    unsignedinteger: "1",
    unsignedsmallinteger: "1",
    unsignedbiginteger: "1",
    reference: "1",
    float: "1.0",
    decimal: `"0"`,
    boolean: "false",
    datetime: `"2024-01-01T00:00:00.000Z"`,
    date: `"2024-01-01"`,
    email: `"sample@example.com"`,
    binary: JSON.stringify(SAMPLE_BINARY_BASE64),
  },
} satisfies ConverterModule;
