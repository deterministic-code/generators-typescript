import { typeHasTag } from "@deterministic-code/generators-common/spec-types";
import type {
  Type,
  TypeField,
} from "@deterministic-code/deterministic-specifications-typescript/parser";

export type OwnedDictionary = {
  name: string;
  owner: string;
  keyType: string;
  valueType: string;
};

const splitDot = (value: string): [string, string] | undefined => {
  const i = value.indexOf(".");
  return i === -1 ? undefined : [value.slice(0, i), value.slice(i + 1)];
};

const identityNames = (
  type: Type | undefined,
  byName: Map<string, Type>,
  stack: Set<string> = new Set(),
): Set<string> => {
  if (!type) return new Set();
  if (stack.has(type.name)) return new Set();
  if (type.ids !== undefined && type.ids.length > 0) return new Set(type.ids);
  const marked = type.fields.filter((f) => f.isId === true).map((f) => f.name);
  if (marked.length > 0) return new Set(marked);
  if (type.inherits === "set") return new Set(["id"]);
  if (type.inherits && type.inherits !== "dictionary") {
    stack.add(type.name);
    return identityNames(byName.get(type.inherits), byName, stack);
  }
  return new Set();
};

const isOwnerIdentityRef = (
  references: TypeField["references"],
  selfName: string,
  byName: Map<string, Type>,
): boolean => {
  if (references === undefined) return false;
  const parts = (Array.isArray(references) ? references : [references]).map(
    (ref) => {
      const split = splitDot(ref);
      return split ? { type: split[0], field: split[1] } : { type: "", field: ref };
    },
  );
  const owner = parts[0]!.type;
  if (!owner || owner === selfName) return false;
  const identity = identityNames(byName.get(owner), byName);
  return parts.every((p) => p.type === owner && identity.has(p.field));
};

const ownerOf = (type: Type, byName: Map<string, Type>): string | undefined => {
  for (const field of type.fields) {
    if (!isOwnerIdentityRef(field.references, type.name, byName)) continue;
    const refs = Array.isArray(field.references)
      ? field.references
      : [field.references!];
    return splitDot(refs[0]!)?.[0];
  }
  return undefined;
};

export const ownedDictionariesOf = (
  types: readonly Type[],
): OwnedDictionary[] => {
  const byName = new Map(types.map((t) => [t.name, t]));
  const out: OwnedDictionary[] = [];
  for (const type of types) {
    if (type.inherits !== "dictionary") continue;
    const key = type.fields.find((f) => f.name === "key");
    const value = type.fields.find((f) => f.name === "value");
    const owner = ownerOf(type, byName);
    if (owner === undefined || key === undefined || value === undefined) {
      continue;
    }
    out.push({
      name: type.name,
      owner,
      keyType: key.type,
      valueType: value.type,
    });
  }
  return out;
};

export const datasourceParentOf = (
  view: Type,
  byName: Map<string, Type>,
): string | undefined => {
  if (typeHasTag(view, "datasource_type")) return view.name;
  let name = view.inherits;
  const stack = new Set<string>();
  while (
    name !== undefined &&
    name !== "set" &&
    name !== "dictionary" &&
    !stack.has(name)
  ) {
    stack.add(name);
    const parent = byName.get(name);
    if (parent === undefined) return undefined;
    if (typeHasTag(parent, "datasource_type")) return parent.name;
    name = parent.inherits;
  }
  return undefined;
};

export const dictionariesForView = (
  view: Type,
  byName: Map<string, Type>,
  dictionaries: readonly OwnedDictionary[],
): OwnedDictionary[] => {
  const owner = datasourceParentOf(view, byName);
  if (owner === undefined) return [];
  const taken = new Set(view.fields.map((f) => f.name));
  return dictionaries.filter((d) => d.owner === owner && !taken.has(d.name));
};
