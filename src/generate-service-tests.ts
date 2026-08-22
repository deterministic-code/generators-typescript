import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  DeterministicParser,
  type IDeterministic,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import {
  SERVICES_YAML,
  type DatasourceType,
  type ServiceCandidate,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import {
  asIdType,
  fakeTestData,
  preludeSource,
  withFakerPackagePatch,
} from "./common/fake-test-data.ts";
import { libraryImportSpecifier } from "./library-import.ts";
import { genericTmpl } from "./resources/service-tests.ts";
import { createCasing } from "./common/default-casing.ts";
import { Emit } from "./emit.ts";

class Generator extends Emit {
  private readonly datasources: DatasourceType[];

  constructor(
    raw: Record<string, string>,
    datasources: DatasourceType[],
  ) {
    super(raw);
    this.datasources = datasources;
  }

  from(deterministic: IDeterministic): GenerateEntry[] {
    return deterministic.services.generics.map((c) => this.test(c));
  }

  private test(candidate: ServiceCandidate): GenerateEntry {
    const table = this.datasources.find((d) => d.name === candidate.name);
    const column =
      table?.fields.find((f) => f.isPrimaryKey === true)?.name ?? "id";
    const pkType =
      table?.fields.find((f) => f.name === column)?.type ?? "integer";
    const src = this.imports.service(candidate.name);
    const path = this.imports.serviceTest(candidate.name);
    const fileBase = `${candidate.name}_service`;
    return content(
      path,
      fill(genericTmpl, {
        prelude: preludeSource(fakeTestData),
        repositoriesImport: libraryImportSpecifier(
          "repositories",
          this.settings.libraryReferenceMode,
          this.imports.serviceTestRel(candidate.name),
        ),
        className: this.casing.serviceClassName(candidate.name),
        importPath: this.imports.testSpec(src, fileBase),
        entityNameJson: JSON.stringify(candidate.name),
        pkExpr: `new PrimaryKey(${JSON.stringify(column)}, ${JSON.stringify(pkType)})`,
        idExpr: fakeTestData.id(asIdType(pkType)),
      }),
    );
  }
}

export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(SERVICES_YAML);
  const casing = createCasing(ctx.settings);
  const deterministic = await DeterministicParser(ctx.reader).parse(
    ctx.settings,
    { serviceClassName: (entity) => casing.serviceClassName(entity) },
  );
  return withFakerPackagePatch(
    new Generator(
      ctx.settings,
      deterministic.expandedDatasourceTypes,
    ).from(deterministic),
  );
};
