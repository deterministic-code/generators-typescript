import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  isReadonlyLookup,
  ROUTES_YAML,
} from "@deterministic-code/generators-common/spec-types";
import {
  DeterministicParser,
  type IDeterministic,
  type RouteCandidate,
  type Type,
} from "@deterministic-code/deterministic-generators-common/parser";
import {
  fakeTestData,
  preludeSource,
  withFakerPackagePatch,
} from "./common/fake-test-data.ts";
import { crudTmpl, readonlyTmpl } from "./resources/routes-tests.ts";
import { isDictionaryCandidate } from "./common/dictionary-candidate.ts";
import { bag, Emit } from "./emit.ts";

class Generator extends Emit {
  private readonly types: Type[];

  constructor(raw: Record<string, string>, types: Type[]) {
    super(raw);
    this.types = types;
  }

  from(deterministic: IDeterministic): GenerateEntry[] {
    return deterministic.routes.candidates
      .filter((c) => !isDictionaryCandidate(c))
      .map((c) => this.test(c));
  }

  private test(candidate: RouteCandidate): GenerateEntry {
    const table = this.types.find((d) => d.name === candidate.name);
    const path = this.imports.routeTest(candidate.name);
    const routeImport = this.imports.spec(
      this.imports.routeTestRel(candidate.name),
      this.imports.routeRel(candidate.name),
    );
    const fnName = this.casing.routerFnName(candidate.name);
    const attrs = bag({
      module: this.imports.routeTestRel(candidate.name),
      imports: this.imports.routeRel(candidate.name),
      uses: fnName,
    });
    const body = fill(
      table !== undefined && isReadonlyLookup(table) ? readonlyTmpl : crudTmpl,
      {
        prelude: preludeSource(fakeTestData),
        fnName,
        routeImport,
      },
    );
    return content(path, body, attrs);
  }
}

/** Returns attributed entries. Cross-lane route imports need host `finalizeEntries`. */
export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(ROUTES_YAML);
  const deterministic = await DeterministicParser(ctx.reader).parse(
    ctx.settings,
  );
  return withFakerPackagePatch(
    new Generator(ctx.settings, deterministic.expandedTypes).from(
      deterministic,
    ),
  );
};
