/** The all-zero uuid, shared by the SQL and language default renderers for the `Empty` uuid token. */
export const EMPTY_UUID = "00000000-0000-0000-0000-000000000000";

/** Field types whose `default_value` renders as a bare numeric literal (no quoting) in every target. */
export const NUMERIC_LITERAL_TYPES = new Set([
  "number",
  "integer",
  "smallinteger",
  "biginteger",
  "float",
  "decimal",
  "reference",
]);

/** Tokens whose value is produced fresh per row (a generator, not a constant) — a consumer that caches one value (e.g. a Zod `.default`) must wrap these in a thunk. */
export const GENERATIVE_TOKENS = new Set(["Now", "UtcNow", "NewId"]);

const DATETIME_LITERAL = /^DateTime\('(.*)'\)$/;
const UUID_LITERAL = /^uuid\('(.*)'\)$/;
const HEX_LITERAL = /^Hex\('(.*)'\)$/;

interface DefaultToken {
  token: string;
  arg?: string | boolean;
}

/** Classify a field's `default_value` into `{ token, arg }` — the one place the symbolic-default grammar (Now/UtcNow/NewId/Empty/Hex, `DateTime('…')`, `uuid('…')`, numeric/boolean/string literals) is parsed, so the SQL renderer, language renderer, and validator agree. */
export function parseDefaultToken(type: string, value: unknown): DefaultToken {
  if (value === undefined || value === null) return { token: "None" };
  const v = String(value);
  if (type === "boolean") return { token: "Boolean", arg: Boolean(value) };
  if (NUMERIC_LITERAL_TYPES.has(type)) return { token: "Numeric", arg: v };
  if (type === "datetime") return datetimeToken(v);
  if (type === "uuid") return uuidToken(v);
  if (type === "binary") return hexToken(v);
  return { token: "String", arg: v };
}

function datetimeToken(v: string): DefaultToken {
  if (v === "Now") return { token: "Now" };
  if (v === "UtcNow") return { token: "UtcNow" };
  const m = DATETIME_LITERAL.exec(v);
  return { token: "DateTime", arg: m ? m[1] : v };
}

function uuidToken(v: string): DefaultToken {
  if (v === "NewId") return { token: "NewId" };
  if (v === "Empty") return { token: "Empty" };
  const m = UUID_LITERAL.exec(v);
  return { token: "Uuid", arg: m ? m[1] : v };
}

function hexToken(v: string): DefaultToken {
  const m = HEX_LITERAL.exec(v);
  return { token: "Hex", arg: m ? m[1] : v };
}

/** The bytes of a hex string as an array of numbers — the language renderers' source for byte-array default literals. */
export function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    out.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}
