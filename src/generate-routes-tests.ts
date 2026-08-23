import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  isReadonlyLookup,
  pkName,
  ROUTES_YAML,
  tableByName,
} from "@deterministic-code/generators-common/spec-types";
import {
  DeterministicParser,
  type DatasourceTable,
  type IDeterministic,
  type RouteByField,
  type RouteCandidate,
  type Type,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import {
  asIdType,
  fakeTestData,
  preludeSource,
  withFakerPackagePatch,
} from "./common/fake-test-data.ts";
import { libraryImportSpecifier } from "./library-import.ts";
import {
  byFieldDeleteListTmpl,
  byFieldDeleteUniqueTmpl,
  byFieldGetListTmpl,
  byFieldGetUniqueTmpl,
  byFieldPutListTmpl,
  byFieldPutUniqueTmpl,
  crudTmpl,
  mockFactoryTmpl,
  readonlyTmpl,
} from "./resources/routes-tests.ts";
import { Emit } from "./emit.ts";

const byFieldTokens = (
  mountPath: string,
  entry: RouteByField,
  ifMatch: string,
) => ({
  mountPath,
  kebab: entry.byField,
  byField: entry.byField,
  ifMatch,
});

const byFieldsBlock = (
  mountPath: string,
  byFields: RouteByField[],
  ifMatch: string,
): string =>
  byFields
    .flatMap((entry) => {
      const methods = entry.methods ?? ["GET", "PUT", "DELETE"];
      const tokens = byFieldTokens(mountPath, entry, ifMatch);
      const out: string[] = [];
      if (methods.includes("GET")) {
        out.push(
          fill(
            entry.byFieldUnique ? byFieldGetUniqueTmpl : byFieldGetListTmpl,
            tokens,
          ),
        );
      }
      if (methods.includes("PUT")) {
        out.push(
          fill(
            entry.byFieldUnique ? byFieldPutUniqueTmpl : byFieldPutListTmpl,
            tokens,
          ),
        );
      }
      if (methods.includes("DELETE")) {
        out.push(
          fill(
            entry.byFieldUnique
              ? byFieldDeleteUniqueTmpl
              : byFieldDeleteListTmpl,
            tokens,
          ),
        );
      }
      return out;
    })
    .join("");

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
    return deterministic.routes.candidates.map((c) => this.test(c));
  }

  private test(candidate: RouteCandidate): GenerateEntry {
    const table = this.types.find((d) => d.name === candidate.name);
    const overlay = this.tables.get(candidate.name);
    const column =
      table !== undefined ? pkName(table, overlay) : "id";
    const pkType =
      table?.fields.find((f) => f.name === column)?.type ?? "integer";
    const path = this.imports.routeTest(candidate.name);
    const fileBase = candidate.name;
    const mountPath = `/api/${candidate.name}`;
    const occ = this.settings.usesOptimisticConcurrency({
      tags: table?.tags ?? candidate.tags,
      useOptimisticConcurrency: overlay?.useOptimisticConcurrency,
    });
    const ifMatch = occ ? `.set("If-Match", occToken)` : "";
    const shared = {
      prelude: preludeSource(fakeTestData),
      pkImport: `import { PrimaryKey } from "${libraryImportSpecifier(
        "repositories",
        this.settings.libraryReferenceMode,
        path,
      )}";`,
      fnName: this.casing.routerFnName(candidate.name),
      fileBase,
      mockFactory: mockFactoryTmpl,
      pkExpr: `new PrimaryKey(${JSON.stringify(column)}, ${JSON.stringify(pkType)})`,
      mountPath,
      idFieldName: column,
      idExpr: fakeTestData.id(asIdType(pkType)),
      fkSuffix: "",
      byFieldsBlock: byFieldsBlock(mountPath, candidate.byFields, ifMatch),
    };
    if (table !== undefined && isReadonlyLookup(table)) {
      return content(path, fill(readonlyTmpl, shared));
    }
    return content(
      path,
      fill(crudTmpl, {
        ...shared,
        entity: candidate.name,
        nameSuffix: "",
        occDecl: occ ? `  const occToken = new Date().toISOString();\n` : "",
        ifMatch,
        occCallArg: occ ? `, { expectedUpdated: occToken }` : "",
      }),
    );
  }
}

export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(ROUTES_YAML);
  const deterministic = await DeterministicParser(ctx.reader).parse(
    ctx.settings,
  );
  return withFakerPackagePatch(
    new Generator(
      ctx.settings,
      deterministic.expandedTypes,
      tableByName(deterministic),
    ).from(deterministic),
  );
};
