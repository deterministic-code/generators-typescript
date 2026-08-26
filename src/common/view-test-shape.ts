import { fill } from "@deterministic-code/generators-common/fill";
import {
  type Type,
  type TypeField,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import { columnFields } from "@deterministic-code/generators-common/spec-types";
import { toNative } from "../base-type-converter.ts";
import { valueTmpl } from "../resources/view-types-tests.ts";
import { fakeTestData, fieldExpr } from "./fake-test-data.ts";
import type { PackCasing } from "./default-casing.ts";
import { fieldSize } from "./view-shape.ts";

export type ShapeOpts = {
  tables: Map<string, Type>;
  views: Map<string, Type>;
  referenceBackendType: boolean;
  casing: PackCasing;
};

export type ShapeNode = {
  name: string;
  ident: string;
  access: string;
  path: string;
  testName: string;
  type: string;
  nullable: boolean;
  hasDefault: boolean;
  isArray: boolean;
  isObject: boolean;
  isPrimitive: boolean;
  isRoot: boolean;
  expr: string;
  nested: ShapeNode[];
};

export const escapeTestName = (name: string): string =>
  name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const fieldAccess = (ident: string): string =>
  ident.startsWith('"') ? `[${ident}]` : `.${ident}`;

const primitiveExpr = (type: string, size?: number): string =>
  fieldExpr(fakeTestData, type, {
    nativeType: toNative(type),
    size,
  });

const nestedTokens = (
  nested: ShapeNode[],
): Array<{ ident: string; value: string; last: boolean }> =>
  nested.map((child, i, all) => ({
    ident: child.ident,
    value: renderValue(child),
    last: i === all.length - 1,
  }));

export const renderValue = (
  node: Pick<
    ShapeNode,
    "isArray" | "isObject" | "isPrimitive" | "expr" | "nested"
  >,
): string =>
  fill(valueTmpl, {
    isArray: node.isArray,
    isObject: node.isObject,
    isPrimitive: node.isPrimitive,
    expr: node.expr,
    nested: nestedTokens(node.nested),
  }).trimEnd();

export const renderObject = (fields: ShapeNode[]): string =>
  fill(valueTmpl, {
    isArray: false,
    isObject: true,
    isPrimitive: false,
    expr: "",
    nested: nestedTokens(fields),
  }).trimEnd();

const scalarNode = (
  field: {
    name: string;
    type: string;
    isNullable: boolean;
    hasDefault?: boolean;
    size?: TypeField["size"];
  },
  accessPrefix: string,
  pathPrefix: string,
  isRoot: boolean,
  casing: PackCasing,
): ShapeNode => {
  const ident = casing.fieldIdent(field.name);
  const path = pathPrefix === "" ? field.name : `${pathPrefix}.${field.name}`;
  return {
    name: field.name,
    ident,
    access: `${accessPrefix}${fieldAccess(ident)}`,
    path,
    testName: escapeTestName(path),
    type: field.type,
    nullable: field.isNullable,
    hasDefault: field.hasDefault === true,
    isArray: false,
    isObject: false,
    isPrimitive: true,
    isRoot,
    expr: primitiveExpr(field.type, fieldSize(field)),
    nested: [],
  };
};

const dsNodes = (
  name: string,
  opts: ShapeOpts,
  accessPrefix: string,
  pathPrefix: string,
): ShapeNode[] => {
  const table = opts.tables.get(name);
  if (table === undefined) return [];
  return columnFields(table.fields).map((f) =>
    scalarNode(f, accessPrefix, pathPrefix, false, opts.casing),
  );
};

const viewFieldNode = (
  field: TypeField,
  opts: ShapeOpts,
  visited: Set<string>,
  accessPrefix: string,
  pathPrefix: string,
  isRoot: boolean,
): ShapeNode => {
  if (field.kind === "primitive") {
    const ident = opts.casing.fieldIdent(field.name);
    const path = pathPrefix === "" ? field.name : `${pathPrefix}.${field.name}`;
    return {
      name: field.name,
      ident,
      access: `${accessPrefix}${fieldAccess(ident)}`,
      path,
      testName: escapeTestName(path),
      type: field.base,
      nullable: field.isNullable,
      hasDefault: false,
      isArray: field.isArray,
      isObject: false,
      isPrimitive: true,
      isRoot,
      expr: primitiveExpr(field.base, fieldSize(field)),
      nested: [],
    };
  }
  const ident = opts.casing.fieldIdent(field.name);
  const path = pathPrefix === "" ? field.name : `${pathPrefix}.${field.name}`;
  const access = `${accessPrefix}${fieldAccess(ident)}`;
  const childPrefix = field.isArray ? `${access}[0]` : access;
  const isView = opts.views.has(field.base);
  const nested =
    isView && !(opts.referenceBackendType && opts.tables.has(field.base))
      ? viewNodes(field.base, opts, visited, childPrefix, path)
      : dsNodes(field.base, opts, childPrefix, path);
  return {
    name: field.name,
    ident,
    access,
    path,
    testName: escapeTestName(path),
    type: field.type,
    nullable: field.isNullable,
    hasDefault: false,
    isArray: field.isArray,
    isObject: true,
    isPrimitive: false,
    isRoot,
    expr: "",
    nested,
  };
};

const shapedNodes = (
  view: Type,
  opts: ShapeOpts,
  visited: Set<string>,
  accessPrefix: string,
  pathPrefix: string,
  isRoot: boolean,
): ShapeNode[] =>
  view.fields.map((f) =>
    viewFieldNode(f, opts, visited, accessPrefix, pathPrefix, isRoot),
  );

export const viewNodes = (
  name: string,
  opts: ShapeOpts,
  visited: Set<string>,
  accessPrefix = "",
  pathPrefix = "",
  isRoot = false,
): ShapeNode[] => {
  if (visited.has(name)) return [];
  const view = opts.views.get(name);
  if (view === undefined) return [];
  const next = new Set(visited).add(name);
  return shapedNodes(view, opts, next, accessPrefix, pathPrefix, isRoot);
};

export const shapedViewNodes = (
  view: Type,
  opts: ShapeOpts,
): ShapeNode[] =>
  shapedNodes(view, opts, new Set([view.name]), "", "", true);

export const flattenNodes = (nodes: ShapeNode[]): ShapeNode[] =>
  nodes.flatMap((node) => [node, ...flattenNodes(node.nested)]);

export const renderMutatedObject = (
  roots: ShapeNode[],
  target: ShapeNode,
  replacement: "omit" | "null" | string,
): string => {
  const children = (
    nodes: ShapeNode[],
  ): Array<{ ident: string; value: string; last: boolean }> => {
    const kept = nodes.filter(
      (node) => !(node === target && replacement === "omit"),
    );
    return kept.map((node, i, all) => {
      let value: string;
      if (node === target) {
        value = replacement === "null" ? "null" : replacement;
      } else if (node.isObject) {
        value = fill(valueTmpl, {
          isArray: node.isArray,
          isObject: true,
          isPrimitive: false,
          expr: "",
          nested: children(node.nested),
        }).trimEnd();
      } else {
        value = renderValue(node);
      }
      return {
        ident: node.ident,
        value,
        last: i === all.length - 1,
      };
    });
  };
  return fill(valueTmpl, {
    isArray: false,
    isObject: true,
    isPrimitive: false,
    expr: "",
    nested: children(roots),
  }).trimEnd();
};
