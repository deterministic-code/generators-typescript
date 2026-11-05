import {
  nativeTypeFor,
  renderSqlDefault,
  defaultLiteralFor,
  type ConverterField,
  type ConverterModule,
} from "./field-converters/base.ts";
import typescript, {
  SAMPLE_BINARY_BASE64,
} from "./field-converters/typescript.ts";
import rust from "./field-converters/rust.ts";
import { EMPTY_UUID } from "./default-token.ts";
import csharp from "./field-converters/csharp.ts";
import sqlite from "./field-converters/sqlite.ts";
import mysql from "./field-converters/mysql.ts";
import postgres from "./field-converters/postgres.ts";
import oracle from "./field-converters/oracle.ts";
import sqlserver from "./field-converters/sqlserver.ts";

/** The converter type keys that carry a numeric sample value (a `0` template, a `1` json sample). */
export const NUMERIC_TYPES = new Set([
  "integer",
  "biginteger",
  "smallinteger",
  "number",
  "float",
]);

/** Every per-target field-converter module, keyed by target — the single home each language/dialect registers into. */
export const CONVERTER_MODULES: Record<string, ConverterModule> = {
  typescript,
  rust,
  csharp,
  sqlite,
  mysql,
  postgres,
  oracle,
  sqlserver,
};

/** One registered generate-time converter row the catalog carries — the registry `fieldConverterFor` resolves against. */
interface ConverterRegistration {
  kind: string;
  target_kind: "language" | "dialect";
  target: string;
}

/** The slice of the field-type catalog `fieldConverterFor` reads: the registered generate converters. */
interface ConverterCatalog {
  converters: ConverterRegistration[];
}

export class FieldConverter {
  #mod: ConverterModule;
  #datetimeRepr?: string;

  constructor(mod: ConverterModule, datetimeRepr?: string) {
    this.#mod = mod;
    this.#datetimeRepr = datetimeRepr;
  }

  nativeType(field: ConverterField): string {
    return nativeTypeFor(this.#mod, field, this.#datetimeRepr);
  }

  defaultExpression(field: ConverterField): string | null {
    return this.#mod.targetKind === "dialect"
      ? renderSqlDefault(this.#mod, field)
      : defaultLiteralFor(
          this.#mod,
          { type: field.type, value: field.defaultValue },
          this.#datetimeRepr,
        );
  }

  defaultLiteral(
    type: string,
    value: string | boolean | number | null,
  ): string | null {
    return defaultLiteralFor(this.#mod, { type, value }, this.#datetimeRepr);
  }

  /** The JSON body value a POST e2e test sends for a field of this type — the target's wire representation (rust serializes `decimal`/`uuid` as strings, `binary` as a byte array), so the generated request payload deserializes into the generated struct. */
  jsonSample(field: ConverterField): string {
    const map = this.#mod.jsonSample;
    if (!map) {
      throw new Error(
        `no jsonSample map registered for ${this.#mod.targetKind} "${this.#mod.target}"`,
      );
    }
    const sample = map[field.type];
    if (sample === undefined) {
      throw new Error(
        `no jsonSample for field type "${field.type}" (${this.#mod.target})`,
      );
    }
    return sample;
  }

  /** The generated wire value for a `<type>` field — the single home for "what value does a field of this type get". A `unique` `uuid` returns the target's fresh-uuid expression (`newIdSample`) and a `unique` `string`/`character` its fresh-string expression (`newStringSample`, bounded by `size`), so repeated inserts never collide; every other case returns the fixed `jsonSample` value. */
  generatedSample(field: ConverterField, { unique = false } = {}): string {
    if (unique && field.type === "uuid") {
      return this.#freshSample("newIdSample");
    }
    if (unique && (field.type === "string" || field.type === "character")) {
      const gen = this.#mod.newStringSample;
      if (!gen) {
        throw new Error(
          `no newStringSample generator registered for ${this.#mod.targetKind} "${this.#mod.target}"`,
        );
      }
      return gen(typeof field.size === "number" ? field.size : undefined);
    }
    return this.jsonSample(field);
  }

  #freshSample(hook: "newIdSample"): string {
    const gen = this.#mod[hook];
    if (!gen) {
      throw new Error(
        `no ${hook} generator registered for ${this.#mod.targetKind} "${this.#mod.target}"`,
      );
    }
    return gen();
  }

  /** The plain response-example value a field of `type` takes in a generated OpenAPI response template — target-neutral (an example, not wire source): datetime/uuid a fixed instant/nil, binary an empty string, numerics 0, everything else a `"string"` sentinel. */
  templateSample(type: string): unknown {
    if (type === "datetime") return "2026-01-01T00:00:00Z";
    if (type === "uuid") return EMPTY_UUID;
    if (type === "binary") return "";
    if (type === "boolean") return false;
    if (NUMERIC_TYPES.has(type)) return 0;
    return "string";
  }

  /** The plain (unquoted) sample value a field of `type` takes — the raw-value form of `jsonSample`, for embedding as a JSON literal. `index` keeps generated strings distinguishable; a plain string is clamped to `maxLength`/`minLength`. */
  rawSample(
    type: string,
    index: number,
    {
      maxLength,
      minLength = 0,
    }: { maxLength?: number; minLength?: number } = {},
  ): unknown {
    if (type === "datetime") return "2024-01-01T00:00:00.000Z";
    if (type === "date") return "2024-01-01";
    if (type === "uuid") return EMPTY_UUID;
    if (type === "binary") return SAMPLE_BINARY_BASE64;
    if (type === "email") return `sample-${index}@example.com`;
    const candidate = `sample-${index}`;
    if (typeof maxLength === "number" && candidate.length > maxLength) {
      return "x".repeat(Math.max(minLength, Math.min(maxLength, 1)));
    }
    if (minLength > 0 && candidate.length < minLength) {
      return candidate + "x".repeat(minLength - candidate.length);
    }
    return candidate;
  }

  /** A numeric literal for `value` typed to a target native type (`long`/`short`/`double`/…), from the target module's `numericLiteral` table — so a comparison argument or a narrowing assignment matches the property. A non-numeric native (a String/Guid type absent from the table) returns null. */
  numericLiteralForNative(nativeType: string, value: number): string | null {
    const table = this.#mod.numericLiteral;
    if (!table) {
      throw new Error(
        `no numericLiteral table registered for ${this.#mod.targetKind} "${this.#mod.target}"`,
      );
    }
    const render = table[nativeType];
    return render ? render(value) : null;
  }

  /** A numeric literal for `value` typed to `field`'s native type — resolves the native via `nativeType` (the catalog-backed mapping the type generator uses), then renders it through the target's `numericLiteral` table. */
  numericLiteral(field: ConverterField, value: number): string | null {
    return this.numericLiteralForNative(this.nativeType(field), value);
  }
}

/** Resolve the registered generate-time converter for a target — an unregistered target throws, so a new language/dialect must add a `field_type_converter` row (its `source_url` records where the module lives). */
export function fieldConverterFor({
  targetKind,
  target,
  catalog,
  datetimeRepr,
}: {
  targetKind: "language" | "dialect";
  target: string;
  catalog: ConverterCatalog;
  datetimeRepr?: string;
}): FieldConverter {
  const registered = catalog.converters.find(
    (c) =>
      c.kind === "generate" && c.target_kind === targetKind && c.target === target,
  );
  if (!registered) {
    throw new Error(
      `no generate field converter registered for ${targetKind} "${target}"`,
    );
  }
  const mod = CONVERTER_MODULES[target];
  if (!mod || mod.targetKind !== targetKind) {
    throw new Error(`no field-converter module for ${targetKind} "${target}"`);
  }
  return new FieldConverter(mod, datetimeRepr);
}
