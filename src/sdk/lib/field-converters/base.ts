import { parseDefaultToken, EMPTY_UUID, hexToBytes } from "../default-token.ts";

export { hexToBytes };

/** The `size` a field carries: a scalar length, a `[precision, scale]` tuple, the `"unlimited"` sentinel, or absent. */
export type FieldSize = number | number[] | "unlimited" | null;

/** The field shape every converter reads — `type` is the discriminator; the rest are the optional metadata the sizing/reference/default renderers consult. */
export interface ConverterField {
  type: string;
  name?: string;
  size?: FieldSize;
  referencesType?: string;
  referencesSize?: FieldSize;
  defaultValue?: string | boolean | number | null;
}

/** A `native` renderer for a sized column type — takes the field, returns the dialect/language type string. */
export type NativeRenderer = (field: ConverterField) => string;

/** One `datasource_type → native type` entry in a converter module's `conversions` table. */
export interface Conversion {
  type: string;
  native: string | NativeRenderer;
  display?: string;
  constraints?: string;
  converter?: string;
  rustConverter?: string;
}

/** The parsed-default argument a renderer receives — a string literal or a boolean, or absent for the argument-free generator tokens. */
type DefaultArg = string | boolean;

/** One symbolic-default renderer: turns a token's argument into the target's literal/expression, or `null` when the token has no expression (e.g. sqlite `NewId`). */
type DefaultRenderer = (arg?: DefaultArg) => string | null;

/** A converter module's per-token default renderers, keyed by token name. */
type DefaultsTable = Record<string, DefaultRenderer>;

/** A target's per-native-type numeric-literal renderers, keyed by native type name. */
type NumericLiteralTable = Record<string, (value: number) => string>;

/** One per-target field-converter module: the language/dialect it targets plus its conversion + default-rendering tables. Shared by all eight per-target modules. */
export interface ConverterModule {
  target: string;
  targetKind: "language" | "dialect";
  datetimeStringType?: string;
  datetimeStringDefault?: string;
  conversions: Conversion[];
  defaults: DefaultsTable;
  jsonSample?: Record<string, string>;
  /** The language expression that generates a fresh, collision-free uuid rendered as the field's wire value — the "unique" arm of `generatedSample`. */
  newIdSample?: () => string;
  /** The language expression that generates a fresh, collision-free string rendered as the field's wire value — the "unique" arm of `sampleLiteral` for `string`/`character`. Bounded by `maxLength` so a small unique column can't overflow/409. */
  newStringSample?: (maxLength?: number) => string;
  numericLiteral?: NumericLiteralTable;
}

/** JSON-quote a value as a double-quoted string literal for language default expressions. */
export function dq(value: string | boolean | undefined): string {
  return JSON.stringify(String(value));
}

/** Single-quote a value as a SQL string literal, doubling embedded quotes. */
export function sqlStringLiteral(
  value: string | number | boolean | null | undefined,
): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** The `[precision, scale]` of a decimal field's `size`, or `null` when unspecified — throws on a malformed size so a bad contract fails loudly. */
export function decimalPrecisionScale(
  field: ConverterField,
): [number, number] | null {
  const s = field.size;
  if (Array.isArray(s) && s.length === 2) {
    const [p, sc] = s;
    if (!Number.isInteger(p) || !Number.isInteger(sc))
      throw new Error(
        `decimal field "${field.name}" size must be [precision, scale] integers; got ${JSON.stringify(s)}`,
      );
    return [p, sc];
  }
  if (s === undefined || s === null) return null;
  throw new Error(
    `decimal field "${field.name}" size must be [precision, scale] tuple; got ${JSON.stringify(s)}`,
  );
}

/** True when a sized field (`string`/`binary`) carries no explicit size and defaults to the dialect's unbounded column type. */
export function isUnlimited(size?: FieldSize): boolean {
  return size === "unlimited" || size === undefined || size === null;
}

/** A `native` renderer for a sized column type — `unlimited` when the field has no size, else `render(n)`. */
export function sized(
  unlimited: string,
  render: (n: number) => string,
): NativeRenderer {
  return (field) =>
    isUnlimited(field.size) ? unlimited : render(Number(field.size));
}

/** The four whole-number conversion entries (`number`/`integer` share `intType`) for a target — keeps each dialect's type names local without repeating the entry shape. */
export function numericFamily(
  intType: string,
  smallType: string,
  bigType: string,
): Conversion[] {
  return [
    { type: "number", native: intType },
    { type: "integer", native: intType },
    { type: "smallinteger", native: smallType },
    { type: "biginteger", native: bigType },
  ];
}

/** A fixed-length character field's length, defaulting to 1 when unsized. */
export function charLen(field: ConverterField): number {
  return field.size === undefined || field.size === null
    ? 1
    : Number(field.size);
}

/** The `[precision, scale]` a `decimal` column requires in a dialect that has no sensible default — throws naming the dialect when absent. */
export function requirePrecisionScale(
  field: ConverterField,
  dialect: string,
): [number, number] {
  const ps = decimalPrecisionScale(field);
  if (!ps) {
    throw new Error(
      `decimal field "${field.name}" requires size: [precision, scale] for ${dialect}`,
    );
  }
  return ps;
}

function conversionFor(mod: ConverterModule, type: string): Conversion {
  const entry = mod.conversions.find((c) => c.type === type);
  if (!entry) {
    throw new Error(
      mod.targetKind === "dialect"
        ? `Unknown field type "${type}" for dialect "${mod.target}"`
        : `no ${mod.target} native type for field type "${type}"`,
    );
  }
  return entry;
}

/** The native (language or dialect) type for a field, resolving reference recursion (dialects) and the datetime string representation (languages). */
export function nativeTypeFor(
  mod: ConverterModule,
  field: ConverterField,
  datetimeRepr?: string,
): string {
  if (
    field.type === "reference" &&
    mod.targetKind === "dialect" &&
    field.referencesType !== undefined
  ) {
    return nativeTypeFor(mod, {
      type: field.referencesType,
      size: field.referencesSize,
    });
  }
  if (
    field.type === "datetime" &&
    mod.targetKind === "language" &&
    datetimeRepr === "string"
  ) {
    return mod.datetimeStringType!;
  }
  const { native } = conversionFor(mod, field.type);
  return typeof native === "function" ? native(field) : native;
}

/** One projected `field_type_mapping` display row for a target — the shape `catalogRowsFor` yields. */
export interface CatalogProjectionRow {
  target_kind: "language" | "dialect";
  target: string;
  type: string;
  target_type: string;
  constraints: string | null;
  converter: string | null;
  rust_converter: string | null;
}

/** The catalog `field_type_mapping` display row for each of a target's conversions — the projection the mappings catalog is seeded from. */
export function catalogRowsFor(mod: ConverterModule): CatalogProjectionRow[] {
  return mod.conversions.map((c) => ({
    target_kind: mod.targetKind,
    target: mod.target,
    type: c.type,
    target_type:
      c.display ??
      (typeof c.native === "string"
        ? c.native
        : (() => {
            throw new Error(
              `${mod.target} conversion "${c.type}" needs an explicit display type`,
            );
          })()),
    constraints: c.constraints ?? null,
    converter: c.converter ?? null,
    rust_converter: c.rustConverter ?? null,
  }));
}

/** The SQL `DEFAULT` expression for a field, translating each symbolic default token to this dialect's form — the dialect-invariant cases live here, the varying ones in the dialect module's `defaults` table. */
export function renderSqlDefault(
  mod: ConverterModule,
  field: ConverterField,
): string | null {
  const { token, arg } = parseDefaultToken(field.type, field.defaultValue);
  switch (token) {
    case "None":
      return null;
    case "Numeric":
      return arg as string;
    case "Empty":
      return sqlStringLiteral(EMPTY_UUID);
    case "Boolean":
      return mod.defaults.Boolean(arg);
    case "Now":
      return mod.defaults.Now();
    case "UtcNow":
      return mod.defaults.UtcNow();
    case "NewId":
      return mod.defaults.NewId();
    case "Hex":
      return mod.defaults.Hex(arg);
    default:
      return sqlStringLiteral(arg);
  }
}

/** The language literal/expression for a field's `{ type, value }` default — `null` when absent. Datetime honors the string representation so a `z.string()` field gets an ISO string, not a native date. */
export function defaultLiteralFor(
  mod: ConverterModule,
  field: { type: string; value: string | boolean | number | null | undefined },
  datetimeRepr?: string,
): string | null {
  const { token, arg } = parseDefaultToken(field.type, field.value);
  if (token === "None") return null;
  if (field.type === "datetime" && datetimeRepr === "string") {
    if (token === "Now" || token === "UtcNow") {
      return mod.datetimeStringDefault ?? mod.defaults[token]();
    }
    return dq(arg);
  }
  // decimal is an exact string in every generated language (see decimalFieldConverter), so its default renders through the String path — quoted in TS/C#, `.to_string()` in Rust — not as the bare numeric literal SQL uses.
  if (field.type === "decimal") return mod.defaults.String(arg);
  const render = mod.defaults[token];
  if (!render) {
    throw new Error(
      `${mod.target} converter cannot render default token "${token}"`,
    );
  }
  return render(arg);
}
