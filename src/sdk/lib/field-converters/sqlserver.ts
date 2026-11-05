import {
  sized,
  charLen,
  numericFamily,
  requirePrecisionScale,
  type ConverterModule,
} from "./base.ts";

/** SQL Server field converter: datasource_type → SQL Server column type + `DEFAULT` expression. */
export default {
  target: "sqlserver",
  targetKind: "dialect",
  conversions: [
    {
      type: "string",
      native: sized("NVARCHAR(MAX)", (n) => `NVARCHAR(${n})`),
      display: "NVARCHAR(n) / NVARCHAR(MAX)",
    },
    {
      type: "character",
      native: (f) => `NCHAR(${charLen(f)})`,
      display: "NCHAR(n)",
    },
    ...numericFamily("INT", "SMALLINT", "BIGINT"),
    { type: "unsignedinteger", native: "BIGINT" },
    { type: "unsignedsmallinteger", native: "INT" },
    { type: "unsignedbiginteger", native: "DECIMAL(20)" },
    { type: "float", native: "FLOAT" },
    {
      type: "decimal",
      native: (f) => {
        const [p, s] = requirePrecisionScale(f, "sqlserver");
        return `DECIMAL(${p}, ${s})`;
      },
      display: "DECIMAL(p, s)",
    },
    { type: "boolean", native: "BIT", constraints: "0|1" },
    { type: "datetime", native: "DATETIME2", constraints: "UTC" },
    {
      type: "binary",
      native: sized("VARBINARY(MAX)", (n) => `VARBINARY(${n})`),
      display: "VARBINARY(n) / VARBINARY(MAX)",
    },
    { type: "uuid", native: "UNIQUEIDENTIFIER", constraints: "RFC-4122" },
    { type: "reference", native: "INT" },
  ],
  defaults: {
    Boolean: (v) => (v ? "1" : "0"),
    Now: () => `GETDATE()`,
    UtcNow: () => `GETUTCDATE()`,
    NewId: () => `NEWID()`,
    Hex: (a) => `0x${a}`,
  },
} satisfies ConverterModule;
