import {
  sized,
  charLen,
  numericFamily,
  decimalPrecisionScale,
  type ConverterModule,
} from "./base.ts";

/** Postgres field converter: datasource_type → Postgres column type + `DEFAULT` expression. */
export default {
  target: "postgres",
  targetKind: "dialect",
  conversions: [
    {
      type: "string",
      native: sized("TEXT", (n) => `VARCHAR(${n})`),
      display: "TEXT",
    },
    {
      type: "character",
      native: (f) => `CHAR(${charLen(f)})`,
      display: "CHAR(n)",
    },
    ...numericFamily("INTEGER", "SMALLINT", "BIGINT"),
    { type: "unsignedinteger", native: "BIGINT" },
    { type: "unsignedsmallinteger", native: "INTEGER" },
    { type: "unsignedbiginteger", native: "NUMERIC(20)" },
    { type: "float", native: "DOUBLE PRECISION" },
    {
      type: "decimal",
      native: (f) => {
        const ps = decimalPrecisionScale(f);
        return ps ? `NUMERIC(${ps[0]}, ${ps[1]})` : "NUMERIC";
      },
      display: "NUMERIC(p, s)",
    },
    {
      type: "boolean",
      native: "BOOLEAN",
      constraints: "native (identity)",
      converter: "postgresBooleanFieldConverter",
      rustConverter: "PostgresBooleanConverter",
    },
    {
      type: "datetime",
      native: "TIMESTAMPTZ",
      constraints: "driver returns Date",
      converter: "postgresDateTimeFieldConverter",
      rustConverter: "PostgresDateTimeConverter",
    },
    {
      type: "binary",
      native: "BYTEA",
      constraints: "",
      converter: "postgresBinaryFieldConverter",
      rustConverter: "PostgresBinaryConverter",
    },
    {
      type: "uuid",
      native: "UUID",
      constraints: "RFC-4122 (native)",
      converter: "postgresUuidFieldConverter",
      rustConverter: "PostgresUuidConverter",
    },
    { type: "reference", native: "INTEGER" },
  ],
  defaults: {
    Boolean: (v) => (v ? "TRUE" : "FALSE"),
    Now: () => `LOCALTIMESTAMP`,
    UtcNow: () => `(NOW() AT TIME ZONE 'UTC')`,
    NewId: () => `gen_random_uuid()`,
    Hex: (a) => `'\\x${a}'`,
  },
} satisfies ConverterModule;
