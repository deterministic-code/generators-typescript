import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  DeterministicParser,
  type IDeterministic,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import {
  VIEW_TYPES_YAML,
  type ShapedView,
  type ViewType,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import {
  fakeTestData,
  preludeSource,
  withFakerPackagePatch,
} from "./common/fake-test-data.ts";
import { typeTestTmpl } from "./resources/view-type-validators-tests.ts";
import {
  escapeTestName,
  flattenNodes,
  renderMutatedObject,
  renderObject,
  shapedViewNodes,
  viewNodes,
  type ShapeNode,
  type ShapeOpts,
} from "./common/view-test-shape.ts";
import { Emit } from "./emit.ts";

type CaseTok = {
  name: string;
  fixture: string;
  assertion: string;
};

const MUTABLE_SCALAR = new Set([
  "string",
  "number",
  "boolean",
  "datetime",
  "reference",
  "binary",
]);

const wrongTypeExpr = (type: string): string | undefined => {
  switch (type) {
    case "string":
      return "123";
    case "number":
    case "reference":
      return `"not-a-number"`;
    case "boolean":
      return `"not-a-boolean"`;
    case "datetime":
      return "42";
    case "binary":
      return `"not-binary"`;
    default:
      return undefined;
  }
};

const mutationCases = (
  roots: ShapeNode[],
  targets: ShapeNode[],
  { inherited = false } = {},
): CaseTok[] => {
  const cases: CaseTok[] = [];
  for (const field of targets) {
    const missingPrefix = inherited
      ? "missing inherited required field"
      : "missing required field";
    const nullPrefix = inherited
      ? "null for non-nullable inherited field"
      : "null for non-nullable field";
    if (!field.nullable && !field.hasDefault) {
      cases.push({
        name: escapeTestName(
          `rejects when ${missingPrefix} "${field.path}"`,
        ),
        fixture: renderMutatedObject(roots, field, "omit"),
        assertion: "toThrow",
      });
      cases.push({
        name: escapeTestName(
          `rejects when ${nullPrefix} "${field.path}"`,
        ),
        fixture: renderMutatedObject(roots, field, "null"),
        assertion: "toThrow",
      });
      if (inherited) break;
    }
    if (inherited) continue;
    if (MUTABLE_SCALAR.has(field.type)) {
      const bad = wrongTypeExpr(field.type);
      if (bad !== undefined) {
        cases.push({
          name: escapeTestName(
            `rejects when wrong type on field "${field.path}"`,
          ),
          fixture: renderMutatedObject(roots, field, bad),
          assertion: "toThrow",
        });
      }
    }
  }
  return cases;
};

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
      deterministic.expandedDatasourceTypes.map((t) => [t.name, t]),
    );
    this.views = new Map(
      deterministic.expandedViewTypes.map((v) => [v.name, v]),
    );
    this.referenceBackendType = referenceBackendType;
  }

  from(): GenerateEntry[] {
    return [...this.views.values()].map((view) => this.tests(view));
  }

  private shapedCases(view: ShapedView): CaseTok[] {
    const fields = shapedViewNodes(view, this);
    const declared = view.fields.map((declaredField) => {
      const node = fields.find((f) => f.name === declaredField.name);
      if (node === undefined) {
        throw new Error(`missing shaped field ${declaredField.name}`);
      }
      return node;
    });
    const cases: CaseTok[] = [
      {
        name: "parses a valid payload",
        fixture: renderObject(fields),
        assertion: "not.toThrow",
      },
    ];
    if (fields.some((f) => f.nullable)) {
      cases.push({
        name: "accepts null for nullable fields",
        fixture: renderObject(
          fields.map((f) =>
            f.nullable
              ? {
                  ...f,
                  isObject: false,
                  isPrimitive: true,
                  isArray: false,
                  expr: "null",
                  nested: [],
                }
              : f,
          ),
        ),
        assertion: "not.toThrow",
      });
    }
    const inheritedMutation = fields.find(
      (f) =>
        !declared.some((d) => d.name === f.name) &&
        !f.nullable &&
        !f.hasDefault,
    );
    if (inheritedMutation !== undefined) {
      cases.push(
        ...mutationCases(fields, [inheritedMutation], { inherited: true }),
      );
    }
    cases.push(...mutationCases(fields, flattenNodes(declared)));
    return cases;
  }

  private unionCases(view: Extract<ViewType, { kind: "union" }>): CaseTok[] {
    const cases = view.members.map((name) => ({
      name: escapeTestName(
        `accepts a ${this.casing.convertTypes(name)} member`,
      ),
      fixture: renderObject(viewNodes(name, this, new Set([view.name]))),
      assertion: "not.toThrow",
    }));
    cases.push({
      name: escapeTestName(
        `rejects when matches neither member of union "${view.name}"`,
      ),
      fixture: `{ __not_a_member__: true }`,
      assertion: "toThrow",
    });
    return cases;
  }

  private tests(view: ViewType): GenerateEntry {
    const src = this.imports.viewValidator(view.name);
    return content(
      this.imports.test(src, view.name),
      fill(typeTestTmpl, {
        prelude: preludeSource(fakeTestData),
        schemaVersion: this.settings.schemaVersion,
        schemaName: this.casing.schemaName(view.name),
        viewName: view.name,
        schemaImport: this.imports.testSpec(src, view.name),
        cases:
          view.kind === "union"
            ? this.unionCases(view)
            : this.shapedCases(view),
      }),
    );
  }
}

export const generate = async (
  ctx: GenerateContext,
  basePath = ".",
  referenceBackendType = true,
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(VIEW_TYPES_YAML);
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
