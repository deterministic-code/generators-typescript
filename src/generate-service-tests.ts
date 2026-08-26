import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  datasourceTypesOf,
  identityColumns,
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
import { bag, Emit } from "./emit.ts";

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
    const columns =
      table !== undefined ? identityColumns(table, overlay) : ["id"];
    const keys = (columns.length > 0 ? columns : ["id"]).map((column) => {
      const pkType =
        table?.fields.find((f) => f.name === column)?.type ?? "integer";
      return { column, pkType };
    });
    const column = keys[0]!.column;
    const pkType = keys[0]!.pkType;
    const pkExpr =
      keys.length === 1
        ? `new PrimaryKey(${JSON.stringify(column)}, ${JSON.stringify(pkType)})`
        : `EntityIdentity.of([${keys
            .map(
              (k) =>
                `new PrimaryKey(${JSON.stringify(k.column)}, ${JSON.stringify(k.pkType)})`,
            )
            .join(", ")}])`;
    const idExpr =
      keys.length === 1
        ? fakeTestData.id(asIdType(pkType))
        : `{ ${keys
            .map((k) => `${k.column}: ${fakeTestData.id(asIdType(k.pkType))}`)
            .join(", ")} }`;
    const src = this.imports.service(candidate.name);
    const path = this.imports.serviceTest(candidate.name);
    const fileBase = `${candidate.name}_service`;
    const className = this.casing.serviceClassName(candidate.name);
    return content(
      path,
      fill(genericTmpl, {
        prelude: preludeSource(fakeTestData),
        repositoriesImport: libraryImportSpecifier(
          "repositories",
          this.settings.libraryReferenceMode,
          this.imports.serviceTestRel(candidate.name),
        ),
        className,
        importPath: this.imports.testSpec(src, fileBase),
        entityNameJson: JSON.stringify(candidate.name),
        pkExpr:
          keys.length === 1
            ? `EntityIdentity.of([${pkExpr}])`
            : pkExpr,
        idExpr,
      }),
      bag({
        module: this.imports.serviceTestRel(candidate.name),
        imports: this.imports.serviceRel(candidate.name),
        uses: className,
      }),
    );
  }
}

/** Returns attributed entries. Cross-lane service imports need host `finalizeEntries`. */
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
