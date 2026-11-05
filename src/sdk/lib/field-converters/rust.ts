import { dq, hexToBytes, type ConverterModule } from "./base.ts";
import { EMPTY_UUID } from "../default-token.ts";

/** Rust field converter: datasource_type → Rust type + default-token literal/expression. */
export default {
  target: "rust",
  targetKind: "language",
  datetimeStringType: "String",
  conversions: [
    { type: "string", native: "String" },
    { type: "character", native: "String" },
    { type: "number", native: "i64" },
    { type: "integer", native: "i32" },
    { type: "smallinteger", native: "i16" },
    { type: "biginteger", native: "i64" },
    { type: "unsignedinteger", native: "u32" },
    { type: "unsignedsmallinteger", native: "u16" },
    { type: "unsignedbiginteger", native: "u64" },
    { type: "float", native: "f64" },
    { type: "decimal", native: "String" },
    { type: "boolean", native: "bool" },
    { type: "datetime", native: "chrono::DateTime<chrono::Utc>" },
    { type: "binary", native: "Vec<u8>" },
    { type: "uuid", native: "String" },
    { type: "reference", native: "i64" },
  ],
  defaults: {
    Now: () => "chrono::Utc::now()",
    UtcNow: () => "chrono::Utc::now()",
    NewId: () => "uuid::Uuid::new_v4()",
    Empty: () => "uuid::Uuid::nil()",
    Uuid: (a) => `String::from(${dq(a)})`,
    DateTime: (a) =>
      `${dq(a)}.parse::<chrono::DateTime<chrono::Utc>>().unwrap()`,
    Hex: (a) => `vec![${hexToBytes(a as string).join(", ")}]`,
    Boolean: (a) => (a ? "true" : "false"),
    Numeric: (a) => a as string,
    String: (a) => `String::from(${dq(a)})`,
  },
  newIdSample: () => "uuid::Uuid::new_v4().hyphenated().to_string()",
  newStringSample: (max) =>
    typeof max === "number" && Number.isFinite(max)
      ? `uuid::Uuid::new_v4().simple().to_string().chars().take(${max}).collect::<String>()`
      : `uuid::Uuid::new_v4().simple().to_string()`,
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
    binary: "[]",
  },
} satisfies ConverterModule;
