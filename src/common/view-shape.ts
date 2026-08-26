import { typeHasTag } from "@deterministic-code/generators-common/spec-types";
import type {
  Type,
  TypeField,
} from "@deterministic-code/deterministic-specifications-typescript/parser";

export const isAlias = (view: Type): boolean =>
  typeHasTag(view, "datasource_type") && typeHasTag(view, "view_type");

export const wrapsInheritedDatasource = (
  view: Type,
  datasourceNames: Set<string>,
): boolean =>
  !isAlias(view) &&
  view.kind === "inherit" &&
  view.inherits !== undefined &&
  datasourceNames.has(view.inherits) &&
  (view.removeFields?.length ?? 0) === 0 &&
  view.fields.length === 0;

/** Fields on the expanded view that are not columns of the inherited parent (union mapping, collections). */
export const fieldsBeyondParent = (
  fields: TypeField[],
  parent: Type | undefined,
): TypeField[] => {
  if (parent === undefined) return fields;
  const parentNames = new Set(parent.fields.map((f) => f.name));
  return fields.filter((f) => !parentNames.has(f.name));
};

export const fieldRefKind = (
  field: TypeField,
  typesByName: Map<string, Type>,
): "primitive" | "datasource" | "view" => {
  if (field.kind === "primitive") return "primitive";
  const referenced = typesByName.get(field.base);
  if (referenced === undefined) return "view";
  if (
    typeHasTag(referenced, "view_type") &&
    !typeHasTag(referenced, "datasource_type")
  ) {
    return "view";
  }
  return "datasource";
};

export const fieldSize = (field: {
  size?: TypeField["size"];
}): number | undefined =>
  typeof field.size === "number" ? field.size : undefined;

export const refParent = (field: TypeField): string | undefined => {
  if (field.references === undefined) return undefined;
  return Array.isArray(field.references)
    ? field.references[0]
    : field.references.split(".")[0];
};
