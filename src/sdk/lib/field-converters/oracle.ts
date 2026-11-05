import {
  sized,
  charLen,
  numericFamily,
  requirePrecisionScale,
  type ConverterModule,
} from "./base.ts";

/** Oracle field converter: datasource_type → Oracle column type + `DEFAULT` expression. */
export default {
  target: "oracle",
  targetKind: "dialect",
  conversions: [
    {
      type: "string",
      native: sized("CLOB", (n) => `VARCHAR2(${n})`),
      display: "VARCHAR2(n) / CLOB",
    },
    {
      type: "character",
      native: (f) => `CHAR(${charLen(f)})`,
      display: "CHAR(n)",
    },
    ...numericFamily("NUMBER(10)", "NUMBER(5)", "NUMBER(19)"),
    { type: "unsignedinteger", native: "NUMBER(10)" },
    { type: "unsignedsmallinteger", native: "NUMBER(5)" },
    { type: "unsignedbiginteger", native: "NUMBER(20)" },
    { type: "float", native: "BINARY_DOUBLE" },
    {
      type: "decimal",
      native: (f) => {
        const [p, s] = requirePrecisionScale(f, "oracle");
        return `NUMBER(${p}, ${s})`;
      },
      display: "NUMBER(p, s)",
    },
    { type: "boolean", native: "NUMBER(1)", constraints: "0|1" },
    { type: "datetime", native: "TIMESTAMP", constraints: "UTC" },
    {
      type: "binary",
      native: sized("BLOB", (n) => `RAW(${n})`),
      display: "RAW(n) / BLOB",
    },
    { type: "uuid", native: "VARCHAR2(36)", constraints: "RFC-4122" },
    { type: "reference", native: "NUMBER(10)" },
  ],
  defaults: {
    Boolean: (v) => (v ? "1" : "0"),
    Now: () => `LOCALTIMESTAMP`,
    UtcNow: () => `SYS_EXTRACT_UTC(SYSTIMESTAMP)`,
    NewId: () => `SYS_GUID()`,
    Hex: (a) => `HEXTORAW('${a}')`,
  },
} satisfies ConverterModule;
