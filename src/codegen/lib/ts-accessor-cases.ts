import {
  accessExpr,
  distinctNextTs,
} from "../../sdk/codegen/lib/ts-sample-literal.ts";
import { escapeForTestName } from "./zod-test-cases.ts";

interface FieldAccessorCasesArgs {
  className: string;
  serializedFixture: string;
  entries: Iterable<[string, unknown]>;
  nullableNames: Iterable<string>;
}

/** The shared get/set + set-to-null accessor `it` cases for a generated datasource-type / view-type interface: one per field asserting assignment takes effect (with `next` derived to differ from the initial value), plus one per nullable field asserting it accepts null. Callers supply the resolved class name, the serialized fixture literal, the field entries, and the nullable field names. */
export function renderFieldAccessorCases({
  className,
  serializedFixture,
  entries,
  nullableNames,
}: FieldAccessorCasesArgs): string[] {
  const cases: string[] = [];
  for (const [key, val] of entries) {
    const access = accessExpr(key);
    const nextExpr = distinctNextTs(val);
    cases.push(
      [
        `  it("gets and sets ${escapeForTestName(key)}", () => {`,
        `    const value: ${className} = ${serializedFixture};`,
        `    const next = ${nextExpr};`,
        `    value${access} = next;`,
        `    expect(value${access}).toEqual(next);`,
        `  });`,
      ].join("\n"),
    );
  }
  for (const name of nullableNames) {
    const access = accessExpr(name);
    cases.push(
      [
        `  it("allows setting ${escapeForTestName(name)} to null", () => {`,
        `    const value: ${className} = ${serializedFixture};`,
        `    value${access} = null;`,
        `    expect(value${access}).toBeNull();`,
        `  });`,
      ].join("\n"),
    );
  }
  return cases;
}
