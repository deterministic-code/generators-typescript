import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  datasourceTypesOf,
  TYPES_YAML,
  unionMembers,
  viewTypesOf,
} from "@deterministic-code/generators-common/spec-types";
import {
  DeterministicParser,
  type IDeterministic,
  type Type,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import {
  fieldTestsTmpl,
  typeTestTmpl,
} from "./resources/view-types-tests.ts";
import {
  fakeTestData,
  preludeSource,
  withFakerPackagePatch,
} from "./common/fake-test-data.ts";
import {
  renderObject,
  renderValue,
  shapedViewNodes,
  viewNodes,
  type ShapeNode,
  type ShapeOpts,
} from "./common/view-test-shape.ts";
import { Emit } from "./emit.ts";

const renderFieldTests = (node: ShapeNode, className: string): string =>
  fill(fieldTestsTmpl, {
    className,
    testName: node.testName,
    ident: node.ident,
    access: node.access,
    sampleExpr: renderValue(node),
    nextExpr: renderValue(node),
    nullable: node.nullable,
    isRoot: node.isRoot,
    nestedTests: node.nested
      .map((child) => renderFieldTests(child, className))
      .join(""),
  }).trimEnd() + "\n\n";

class Generator extends Emit implements ShapeOpts {
  readonly tables: ShapeOpts["tables"];
  readonly views: ShapeOpts["views"];
  readonly referenceBackendType: boolean;

  constructor(
    raw: Record<string, string>,
    basePath: string,
    deterministic: IDeterministic,
    referenceBackendType: boolean,
  ) {
    super(raw, basePath);
    this.tables = new Map(
      datasourceTypesOf(deterministic).map((t) => [t.name, t]),
    );
    this.views = new Map(
      viewTypesOf(deterministic).map((v) => [v.name, v]),
    );
    this.referenceBackendType = referenceBackendType;
  }

  from(): GenerateEntry[] {
    return [...this.views.values()].map((view) => this.tests(view));
  }

  private tests(view: Type): GenerateEntry {
    const members = unionMembers(view);
    const fields =
      members === undefined ? shapedViewNodes(view, this) : [];
    const src = this.imports.view(view.name);
    return content(
      this.imports.test(src, view.name),
      fill(typeTestTmpl, {
        prelude: preludeSource(fakeTestData),
        schemaVersion: this.settings.schemaVersion,
        className: this.casing.convertTypes(view.name),
        viewName: view.name,
        typeImport: this.imports.testSpec(src, view.name),
        isShaped: members === undefined,
        isUnion: members !== undefined,
        fixture: fields.length === 0 ? "{}" : renderObject(fields),
        fieldTests: fields
          .map((field) =>
            renderFieldTests(field, this.casing.convertTypes(view.name)),
          )
          .join(""),
        members:
          members !== undefined
            ? members.map((name) => ({
                name: this.casing.convertTypes(name),
                memberClass: this.casing.convertTypes(name),
                memberImport: this.imports.spec(
                  this.imports.viewRel(view.name),
                  this.imports.viewRel(name),
                ),
                memberFixture: renderObject(
                  viewNodes(name, this, new Set([view.name])),
                ),
              }))
            : [],
      }),
    );
  }
}

export const generate = async (
  ctx: GenerateContext,
  basePath = ".",
  referenceBackendType = true,
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(TYPES_YAML);
  const deterministic = await DeterministicParser(ctx.reader).parse(
    ctx.settings,
  );
  return withFakerPackagePatch(
    new Generator(
      ctx.settings,
      basePath,
      deterministic,
      referenceBackendType,
    ).from(),
    basePath === "." || basePath === "" ? "package.json" : "frontend/package.json",
  );
};
