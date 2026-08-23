import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  datasourceTypesOf,
  pkName,
  SERVICES_YAML,
  tableByName,
} from "@deterministic-code/generators-common/spec-types";
import {
  DeterministicParser,
  type DatasourceTable,
  type IDeterministic,
  type ServiceCandidate,
  type Type,
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
  private readonly types: Type[];
  private readonly tables: Map<string, DatasourceTable>;

  constructor(
    raw: Record<string, string>,
    types: Type[],
    tables: Map<string, DatasourceTable>,
  ) {
    super(raw);
    this.types = types;
    this.tables = tables;
  }

  from(deterministic: IDeterministic): GenerateEntry[] {
    return deterministic.services.generics.map((c) => this.test(c));
  }

  private test(candidate: ServiceCandidate): GenerateEntry {
    const table = this.types.find((d) => d.name === candidate.name);
    const overlay = this.tables.get(candidate.name);
    const column =
      table !== undefined ? pkName(table, overlay) : "id";
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
      datasourceTypesOf(deterministic),
      tableByName(deterministic),
    ).from(deterministic),
  );
};
