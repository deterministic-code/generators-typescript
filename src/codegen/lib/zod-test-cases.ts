import { serializeSampleValue as serializeValue } from "../../sdk/codegen/lib/ts-sample-literal.ts";

export function escapeForTestName(s: string): string {
  return s.replace(/"/g, '\\"');
}

/** A deep-enough clone of a fixture for a mutation to edit without disturbing the shared valid fixture — `Uint8Array` fields are copied by value so a binary column survives the round-trip. */
export function cloneFixture(
  fx: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fx)) {
    out[k] = v instanceof Uint8Array ? new Uint8Array(v) : v;
  }
  return out;
}

export function renderValidCase(schemaName: string, fixture: unknown): string {
  return [
    `  it("parses a valid payload", () => {`,
    `    const value = ${serializeValue(fixture)};`,
    `    expect(() => ${schemaName}.parse(value)).not.toThrow();`,
    `  });`,
  ].join("\n");
}

export function renderNullableVariantCase(
  schemaName: string,
  fixture: unknown,
): string {
  return [
    `  it("accepts null for nullable fields", () => {`,
    `    const value = ${serializeValue(fixture)};`,
    `    expect(() => ${schemaName}.parse(value)).not.toThrow();`,
    `  });`,
  ].join("\n");
}

export function renderMutationCase(
  schemaName: string,
  description: string,
  mutated: unknown,
): string {
  return [
    `  it("rejects when ${escapeForTestName(description)}", () => {`,
    `    const value = ${serializeValue(mutated)};`,
    `    expect(() => ${schemaName}.parse(value)).toThrow();`,
    `  });`,
  ].join("\n");
}
