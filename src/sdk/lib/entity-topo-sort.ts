type FieldRec = Record<string, { references?: string }>;

interface EntityDef {
  fields?: FieldRec[];
}

function parseEntities(types: unknown[]): {
  entityNames: string[];
  fieldsByName: Map<string, FieldRec[]>;
} {
  const entityNames: string[] = [];
  const fieldsByName = new Map<string, FieldRec[]>();
  for (const entry of types) {
    const pair = Object.entries(entry as Record<string, EntityDef>)[0];
    if (!pair) {
      throw new Error(
        "topoSortEntities: every entry in datasourceData.types must be a single-key object",
      );
    }
    const [name, def] = pair;
    entityNames.push(name);
    fieldsByName.set(name, Array.isArray(def.fields) ? def.fields : []);
  }
  return { entityNames, fieldsByName };
}

function buildParents(
  entityNames: string[],
  fieldsByName: Map<string, FieldRec[]>,
  known: Set<string>,
): Map<string, Set<string>> {
  const parentsOf = new Map<string, Set<string>>();
  for (const name of entityNames) parentsOf.set(name, new Set());
  for (const child of entityNames) {
    for (const fieldEntry of fieldsByName.get(child)!) {
      const fdef = Object.values(fieldEntry)[0];
      if (!fdef || typeof fdef.references !== "string") continue;
      const parent = fdef.references.split(".")[0];
      if (parent === child || !known.has(parent)) continue;
      parentsOf.get(child)!.add(parent);
    }
  }
  return parentsOf;
}

function applyExtraParents(
  parentsOf: Map<string, Set<string>>,
  extraParents: ReadonlyMap<string, Iterable<string>>,
  known: Set<string>,
): void {
  for (const [child, parents] of extraParents) {
    if (!parentsOf.has(child)) continue;
    for (const parent of parents) {
      if (parent === child || !known.has(parent)) continue;
      parentsOf.get(child)!.add(parent);
    }
  }
}

function kahnSort(
  entityNames: string[],
  parentsOf: Map<string, Set<string>>,
): string[] {
  const inDegree = new Map<string, number>();
  for (const [child, parents] of parentsOf) inDegree.set(child, parents.size);
  const ready = entityNames.filter((n) => inDegree.get(n) === 0);
  const result: string[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    result.push(next);
    for (const child of entityNames) {
      if (parentsOf.get(child)!.has(next)) {
        parentsOf.get(child)!.delete(next);
        inDegree.set(child, inDegree.get(child)! - 1);
        if (inDegree.get(child) === 0) ready.push(child);
      }
    }
  }
  return result;
}

export function topoSortEntities(
  datasourceData: unknown,
  extraParents: ReadonlyMap<string, Iterable<string>> | null = null,
): string[] {
  if (!datasourceData || typeof datasourceData !== "object") {
    throw new Error(
      "topoSortEntities: datasourceData must be a non-null object",
    );
  }
  const types = (datasourceData as { types?: unknown }).types;
  if (!Array.isArray(types)) {
    throw new Error("topoSortEntities: datasourceData.types must be an array");
  }
  const { entityNames, fieldsByName } = parseEntities(types);
  const known = new Set(entityNames);
  const parentsOf = buildParents(entityNames, fieldsByName, known);
  if (extraParents) applyExtraParents(parentsOf, extraParents, known);
  const result = kahnSort(entityNames, parentsOf);
  if (result.length !== entityNames.length) {
    const remaining = entityNames.filter((n) => !result.includes(n));
    throw new Error(
      `topoSortEntities: FK cycle detected among entities: ${remaining.join(", ")}`,
    );
  }
  return result;
}
