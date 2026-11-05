import {
  sized,
  charLen,
  numericFamily,
  decimalPrecisionScale,
  type ConverterField,
  type ConverterModule,
} from "./base.ts";

/** Max chars a utf8mb4 `VARCHAR` can hold before MySQL's 65535-byte row limit forces `LONGTEXT`. */
export const MYSQL_VARCHAR_MAX_CHARS_UTF8MB4 = 16383;
/** Max bytes a `VARBINARY` can hold before MySQL forces `LONGBLOB`. */
export const MYSQL_VARBINARY_MAX_BYTES = 65535;

function mysqlStringColumnType(n: number): string {
  return n <= MYSQL_VARCHAR_MAX_CHARS_UTF8MB4 ? `VARCHAR(${n})` : "LONGTEXT";
}

function mysqlBinaryColumnType(n: number): string {
  return n <= MYSQL_VARBINARY_MAX_BYTES ? `VARBINARY(${n})` : "LONGBLOB";
}

function mysqlDecimal(field: ConverterField): string {
  const ps = decimalPrecisionScale(field);
  return ps ? `DECIMAL(${ps[0]}, ${ps[1]})` : "DECIMAL(10, 2)";
}

/** MySQL field converter: datasource_type → MySQL column type + `DEFAULT` expression. */
export default {
  target: "mysql",
  targetKind: "dialect",
  conversions: [
    {
      type: "string",
      native: sized("TEXT", mysqlStringColumnType),
      display: "VARCHAR(n) / LONGTEXT",
    },
    {
      type: "character",
      native: (f) => `CHAR(${charLen(f)})`,
      display: "CHAR(n)",
    },
    ...numericFamily("INT", "SMALLINT", "BIGINT"),
    { type: "unsignedinteger", native: "INT UNSIGNED" },
    { type: "unsignedsmallinteger", native: "SMALLINT UNSIGNED" },
    { type: "unsignedbiginteger", native: "BIGINT UNSIGNED" },
    { type: "float", native: "DOUBLE" },
    {
      type: "decimal",
      native: (f) => mysqlDecimal(f),
      display: "DECIMAL(p, s)",
    },
    {
      type: "boolean",
      native: "TINYINT(1)",
      constraints: "0|1 on the wire",
      converter: "mysqlBooleanFieldConverter",
      rustConverter: "MysqlBooleanConverter",
    },
    {
      type: "datetime",
      native: "DATETIME(3)",
      display: "DATETIME",
      constraints: "driver returns Date",
      converter: "mysqlDateTimeFieldConverter",
      rustConverter: "MysqlDateTimeConverter",
    },
    {
      type: "binary",
      native: sized("BLOB", mysqlBinaryColumnType),
      display: "VARBINARY(n) / LONGBLOB",
      constraints: "VARBINARY(n) for n <= 65535, else LONGBLOB",
      converter: "mysqlBinaryFieldConverter",
      rustConverter: "MysqlBinaryConverter",
    },
    {
      type: "uuid",
      native: "CHAR(36)",
      constraints: "RFC-4122",
      converter: "mysqlUuidFieldConverter",
      rustConverter: "MysqlUuidConverter",
    },
    { type: "reference", native: "INT" },
  ],
  defaults: {
    Boolean: (v) => (v ? "1" : "0"),
    Now: () => `(NOW(3))`,
    UtcNow: () => `(UTC_TIMESTAMP(3))`,
    NewId: () => `(UUID())`,
    Hex: (a) => `X'${a}'`,
  },
} satisfies ConverterModule;
