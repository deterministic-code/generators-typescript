import { RuntimeValue } from "../../sdk/codegen/lib/ts-sample-literal.ts";
import { converterTypeForSchema } from "../../sdk/lib/schema-build.ts";
import { NUMERIC_TYPES } from "../../sdk/lib/field-converter.ts";

interface SchemaNode {
  $ref?: string;
  type?: string;
  format?: string;
  enum?: unknown[];
  pattern?: string;
  maxLength?: number;
  oneOf?: SchemaNode[];
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  nullable?: boolean;
}

type Components = Record<string, SchemaNode>;

interface SampleCtx {
  components: Components;
  datetime: string;
  ident: (key: string) => string;
  nullableVariant: boolean;
}

interface SampleOptions {
  datetime?: string;
  ident?: (key: string) => string;
}

interface IdentOptions {
  ident?: (key: string) => string;
}

interface Mutation {
  description: string;
  mutate: (fx: Record<string, unknown>) => Record<string, unknown>;
}

interface ScalarSetField {
  key: string;
  next: unknown;
}

const REF_PREFIX = "#/components/schemas/";

function refName(ref: string): string {
  return ref.slice(REF_PREFIX.length);
}

function scalarSample(schema: SchemaNode, datetime: string): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  const key = converterTypeForSchema(schema);
  if (NUMERIC_TYPES.has(key)) return 1;
  if (key === "boolean") return true;
  if (key === "uuid") return new RuntimeValue("uuid");
  if (key === "datetime") return new RuntimeValue("datetime", { datetime });
  if (key === "date") return new RuntimeValue("date");
  if (key === "binary") return new Uint8Array(0);
  if (key === "email") return new RuntimeValue("email");
  // A pattern-constrained string can't take a random value and still match, so keep a stable literal there.
  if (typeof schema.pattern === "string") {
    return Number.isFinite(schema.maxLength)
      ? "sample".slice(0, schema.maxLength) || "s"
      : "sample";
  }
  return new RuntimeValue("string", { size: schema.maxLength });
}

// A complete sample value for one schema node: `$ref` resolves through the components map (a re-entered ref yields null, mirroring schema-sample's cycle guard), `oneOf` picks its first member, arrays carry one element, and objects fill EVERY property (not just required) so the value matches the frontend_types interface shape, not only what zod would accept.
function baseSample(
  schema: SchemaNode | undefined,
  ctx: SampleCtx,
  seen: Set<string>,
): unknown {
  if (!schema || typeof schema !== "object") return null;
  if (schema.$ref) {
    const name = refName(schema.$ref);
    if (seen.has(name)) return null;
    return objectSample(ctx.components[name], ctx, new Set(seen).add(name));
  }
  if (Array.isArray(schema.oneOf)) {
    return baseSample(schema.oneOf[0], ctx, seen);
  }
  if (schema.type === "array") {
    return [baseSample(schema.items, ctx, seen)];
  }
  return scalarSample(schema, ctx.datetime);
}

function objectSample(
  schema: SchemaNode | undefined,
  ctx: SampleCtx,
  seen: Set<string>,
): unknown {
  if (!schema || typeof schema !== "object") return null;
  if (schema.$ref || schema.oneOf || schema.type === "array") {
    return baseSample(schema, ctx, seen);
  }
  const out: Record<string, unknown> = {};
  const props = schema.properties ?? {};
  for (const [key, prop] of Object.entries(props)) {
    const outKey = ctx.ident(key);
    if (
      ctx.nullableVariant &&
      prop.nullable === true &&
      prop.type !== "array"
    ) {
      out[outKey] = null;
      continue;
    }
    out[outKey] = baseSample(prop, ctx, seen);
  }
  return out;
}

const IDENTITY = (key: string): string => key;

/** A complete JS value conforming to an arbitrary schema node (inline object, `$ref`, array, or scalar), resolving refs through `components`. The request/response-body counterpart of `sampleForComponent` for client-binding tests, whose bodies are frequently inline rather than named. */
export function sampleForSchema(
  schema: unknown,
  components: unknown,
  { datetime = "string", ident = IDENTITY }: SampleOptions = {},
): unknown {
  return objectSample(
    schema as SchemaNode,
    {
      components: components as Components,
      datetime,
      ident,
      nullableVariant: false,
    },
    new Set<string>(),
  );
}

/** A complete JS value conforming to component `name`, filling every property so it satisfies both the frontend_types interface and the zod schema. `datetime` picks the date-time representation: `"native"` yields `Date` objects (matching the generated interface), `"string"` yields ISO strings (the wire shape client bodies and `z.coerce.date()` accept). `ident` casing-maps each property key so the fixture matches the generated field names (types/validators pass `CodegenFieldNames.ident`; wire-key bodies pass identity). */
export function sampleForComponent(
  name: string,
  components: unknown,
  { datetime = "string", ident = IDENTITY }: SampleOptions = {},
): Record<string, unknown> {
  const comps = components as Components;
  const schema = comps[name];
  if (!schema)
    throw new Error(`sampleForComponent: unknown component "${name}"`);
  return objectSample(
    schema,
    { components: comps, datetime, ident, nullableVariant: false },
    new Set<string>([name]),
  ) as Record<string, unknown>;
}

/** Like `sampleForComponent`, but every top-level nullable field is set to `null` — the payload that proves a `.nullable()` schema accepts null. */
export function nullableVariantForComponent(
  name: string,
  components: unknown,
  { datetime = "string", ident = IDENTITY }: SampleOptions = {},
): unknown {
  const comps = components as Components;
  const schema = comps[name];
  if (!schema)
    throw new Error(`nullableVariantForComponent: unknown component "${name}"`);
  return objectSample(
    schema,
    { components: comps, datetime, ident, nullableVariant: true },
    new Set<string>([name]),
  );
}

/** The top-level nullable field names of component `name` (casing-mapped by `ident`) — the set a nullable-variant payload nulls out (empty means no nullable field, so no nullable case is worth generating). */
export function nullableFieldNames(
  name: string,
  components: unknown,
  { ident = IDENTITY }: IdentOptions = {},
): string[] {
  const props = (components as Components)[name]?.properties ?? {};
  return Object.keys(props)
    .filter(
      (key) => props[key].nullable === true && props[key].type !== "array",
    )
    .map(ident);
}

function isPlainScalar(prop: SchemaNode): boolean {
  return (
    !prop.$ref &&
    !prop.oneOf &&
    prop.type !== "array" &&
    (prop.type === "integer" ||
      prop.type === "number" ||
      prop.type === "boolean" ||
      prop.type === "string")
  );
}

// A z.coerce.date() field accepts a number as a timestamp, so a numeric "wrong type" on a date-time field would parse — those fields get no wrong-type mutation. Enums reject any non-member, so a sentinel string is the clean invalid value.
function wrongTypeValue(prop: SchemaNode): unknown {
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return "__invalid__";
  if (prop.format === "date-time") return null;
  switch (prop.type) {
    case "string":
      return 123;
    case "integer":
    case "number":
      return "not-a-number";
    case "boolean":
      return "not-a-boolean";
    default:
      return null;
  }
}

/** The invalid-payload mutations for component `name`: dropping or nulling each required (non-nullable) field, and wrong-typing each plain scalar. Each `{ description, mutate }` transforms a valid fixture (keyed by `ident`) into one the zod schema must reject — the negative half of the validators test. */
export function enumerateComponentMutations(
  name: string,
  components: unknown,
  { ident = IDENTITY }: IdentOptions = {},
): Mutation[] {
  const schema = (components as Components)[name] ?? {};
  const props = schema.properties ?? {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required : [],
  );
  const mutations: Mutation[] = [];
  for (const [key, prop] of Object.entries(props)) {
    const outKey = ident(key);
    if (required.has(key) && prop.nullable !== true) {
      mutations.push({
        description: `missing required field "${outKey}"`,
        mutate: (fx) => {
          const next = { ...fx };
          delete next[outKey];
          return next;
        },
      });
      mutations.push({
        description: `null for non-nullable field "${outKey}"`,
        mutate: (fx) => ({ ...fx, [outKey]: null }),
      });
    }
    if (isPlainScalar(prop)) {
      const bad = wrongTypeValue(prop);
      if (bad !== null) {
        mutations.push({
          description: `wrong type on field "${outKey}"`,
          mutate: (fx) => ({ ...fx, [outKey]: bad }),
        });
      }
    }
  }
  return mutations;
}

// A second, type-correct value for a plain scalar field, used to prove get/set on the frontend_types interface. Enum, uuid, and date-time fields are excluded by scalarSetFields so this only sees plain string/number/boolean.
function nextScalarValue(prop: SchemaNode): unknown {
  switch (prop.type) {
    case "integer":
    case "number":
      return 2;
    case "boolean":
      return false;
    default:
      return "updated";
  }
}

/** The plain-scalar, non-nullable field names of component `name` (casing-mapped by `ident`) whose value can be reassigned in a get/set accessor test, each paired with a type-correct replacement value. Excludes enum / uuid / date-time / ref / array fields whose typed replacement would be fiddly. */
export function scalarSetFields(
  name: string,
  components: unknown,
  { ident = IDENTITY }: IdentOptions = {},
): ScalarSetField[] {
  const props = (components as Components)[name]?.properties ?? {};
  return Object.entries(props)
    .filter(
      ([, prop]) =>
        isPlainScalar(prop) &&
        prop.nullable !== true &&
        !Array.isArray(prop.enum) &&
        prop.format !== "uuid" &&
        prop.format !== "date-time",
    )
    .map(([key, prop]) => ({ key: ident(key), next: nextScalarValue(prop) }));
}
