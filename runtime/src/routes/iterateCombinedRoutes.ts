interface DatasourceFieldDef {
  type?: string;
  references?: string;
  [key: string]: unknown;
}

export interface DatasourceTypeDef {
  datasource_type?: string;
  inherits?: string;
  fields?: Array<Record<string, DatasourceFieldDef>>;
  [key: string]: unknown;
}

export interface DatasourceData {
  types?: Array<Record<string, DatasourceTypeDef>>;
  datasource_mappings?: readonly unknown[];
}

interface CombinedChildRaw {
  via?: string;
  target?: string;
  route?: string;
}

interface CombinedRoutesEntryDef {
  route?: string;
  combines?: Array<string | Record<string, CombinedChildRaw>>;
  /** @deprecated authored YAML uses `combines`; kept so older fixtures still mount. */
  combined_types?: Array<string | Record<string, CombinedChildRaw>>;
}

export interface RoutesData {
  combined_routes?: Array<Record<string, CombinedRoutesEntryDef>>;
}

export interface DirectFkDescriptor {
  kind: 'direct-fk';
  parent: string;
  parentBasePath: string;
  parentParam: string;
  child: { name: string };
  fkColumn: string;
  segment: string;
  segmentTail: string;
  collectionPath: string;
  memberPath: string;
}

export interface M2mDescriptor {
  kind: 'm2m';
  parent: string;
  parentBasePath: string;
  parentParam: string;
  junction: string;
  target: string;
  targetParam: string;
  segment: string;
  segmentTail: string;
  collectionPath: string;
  memberPath: string;
}

export type CombinedRouteDescriptor = DirectFkDescriptor | M2mDescriptor;

// Naming helpers live in ../naming/; re-exported here so existing consumers keep stable imports, kept in sync with scripts/lib/routes-expand.ts via the parity test.
import { snakeToCamel, kebabPlural } from '../naming';
export { snakeToCamel };

function datasourceIndex(datasourceData: DatasourceData): Map<string, DatasourceTypeDef> {
  const byName = new Map<string, DatasourceTypeDef>();
  for (const entry of datasourceData?.types ?? []) {
    const [name, def] = Object.entries(entry)[0];
    byName.set(name, def);
  }
  return byName;
}

function parentParamName(parentName: string): string {
  return `${snakeToCamel(parentName)}Id`;
}

function rewriteParentPath(rawPath: string, parentName: string): string {
  return rawPath.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    return name === 'id' ? `:${parentParamName(parentName)}` : `:${name}`;
  });
}

const inheritName = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const prefixed = raw.match(/^datasource_types\.([a-z_][a-z0-9_]*)$/);
  if (prefixed) return prefixed[1];
  if (/^[a-z_][a-z0-9_]*$/.test(raw)) return raw;
  return null;
};

const refTable = (references: unknown): string | null => {
  if (typeof references !== 'string' || references.length === 0) return null;
  const cleaned = references.startsWith('datasource_types.')
    ? references.slice('datasource_types.'.length)
    : references;
  const table = cleaned.split('.')[0];
  return table !== undefined && table.length > 0 ? table : null;
};

const ancestorNames = (
  def: DatasourceTypeDef,
  byName: Map<string, DatasourceTypeDef>,
): string[] => {
  const out: string[] = [];
  let current = inheritName(def.inherits);
  const walking = new Set<string>();
  while (current !== null && !walking.has(current)) {
    walking.add(current);
    out.push(current);
    current = inheritName(byName.get(current)?.inherits);
  }
  return out;
};

const ownFields = (def: DatasourceTypeDef): Array<[string, DatasourceFieldDef]> =>
  (Array.isArray(def.fields) ? def.fields : []).flatMap((entry) => {
    const pair = Object.entries(entry)[0];
    return pair === undefined ? [] : [[pair[0], pair[1]]];
  });

const fieldsWithInherits = (
  def: DatasourceTypeDef,
  byName: Map<string, DatasourceTypeDef> | undefined,
): Array<[string, DatasourceFieldDef]> => {
  const fields = ownFields(def);
  if (byName === undefined) return fields;
  const seen = new Set(fields.map(([name]) => name));
  for (const ancestor of ancestorNames(def, byName)) {
    const ancestorDef = byName.get(ancestor);
    if (ancestorDef === undefined) continue;
    for (const [name, field] of ownFields(ancestorDef)) {
      if (seen.has(name)) continue;
      seen.add(name);
      fields.push([name, field]);
    }
  }
  return fields;
};

const refMatchesParent = (
  target: string,
  parentName: string,
  byName: Map<string, DatasourceTypeDef> | undefined,
): boolean => {
  if (target === parentName) return true;
  if (byName === undefined) return false;
  const parentDef = byName.get(parentName);
  return parentDef !== undefined && ancestorNames(parentDef, byName).includes(target);
};

/** Own fields, then inherited. A view FK to `contacts_base.id` matches parent `contact` when contact inherits that table. */
export const findForeignKeyTo = (
  childDef: DatasourceTypeDef,
  parentName: string,
  datasourceByName?: Map<string, DatasourceTypeDef>,
): string | null => {
  for (const [fname, fdef] of fieldsWithInherits(childDef, datasourceByName)) {
    const target = refTable(fdef.references);
    if (target !== null && refMatchesParent(target, parentName, datasourceByName)) {
      return fname;
    }
  }
  return null;
};

function kebabToSnake(s: string): string {
  return s.replace(/-/g, '_');
}

interface NormalizedChild {
  name: string;
  via: string | null;
  target: string | null;
  route: string | null;
}

function normalizeCombinedChild(child: string | Record<string, CombinedChildRaw>): NormalizedChild {
  if (typeof child === 'string') {
    return { name: kebabToSnake(child), via: null, target: null, route: null };
  }
  const [rawName, def] = Object.entries(child)[0];
  return {
    name: kebabToSnake(rawName),
    via: def && typeof def.via === 'string' ? def.via : null,
    target: def && typeof def.target === 'string' ? def.target : null,
    route: def && typeof def.route === 'string' ? def.route : null,
  };
}

interface JunctionMatch {
  name: string;
  parentFk: string;
  childFk: string;
}

function detectJunction(
  parentName: string,
  childName: string,
  datasourceByName: Map<string, DatasourceTypeDef>,
): JunctionMatch | null {
  const matches: JunctionMatch[] = [];
  for (const [name, def] of datasourceByName) {
    if (name === parentName || name === childName) continue;
    const parentFk = findForeignKeyTo(def, parentName, datasourceByName);
    const childFk = findForeignKeyTo(def, childName, datasourceByName);
    if (parentFk && childFk) {
      matches.push({ name, parentFk, childFk });
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const candidates = matches.map((m) => m.name).join(', ');
    throw new Error(
      `combined_routes: ambiguous junction between "${parentName}" and "${childName}" — candidates: ${candidates}. Add via: to disambiguate.`,
    );
  }
  return matches[0];
}

function defaultChildSegment(name: string): string {
  return `/${kebabPlural(name)}`;
}

export function* iterateCombinedRoutes({
  routesData,
  datasourceData,
}: {
  routesData: RoutesData;
  datasourceData: DatasourceData;
}): Generator<CombinedRouteDescriptor> {
  const datasourceByName = datasourceIndex(datasourceData);
  const combined = routesData.combined_routes ?? [];

  for (const entry of combined) {
    const [parentName, def] = Object.entries(entry)[0];
    const parentBasePath = rewriteParentPath(def.route ?? '', parentName);
    const parentParam = parentParamName(parentName);

    for (const rawChild of def.combines ?? def.combined_types ?? []) {
      const child = normalizeCombinedChild(rawChild);

      if (child.via || child.target) {
        const junctionName = child.via;
        const targetName = child.target;
        if (!junctionName || !targetName) {
          throw new Error(
            `combined_routes: M2M child must declare both via: and target: (parent=${parentName}, child=${child.name})`,
          );
        }
        if (!datasourceByName.has(junctionName)) {
          throw new Error(
            `combined_routes: junction "${junctionName}" not found in types.yaml`,
          );
        }

        const segment = child.route ?? defaultChildSegment(targetName);
        const tail = segment.split('/').filter(Boolean).pop() ?? '';
        const collection = `${parentBasePath}${segment}`;
        const memberPath = `${collection}/:${snakeToCamel(targetName)}Id`;

        yield {
          kind: 'm2m',
          parent: parentName,
          parentBasePath,
          parentParam,
          junction: junctionName,
          target: targetName,
          targetParam: `${snakeToCamel(targetName)}Id`,
          segment,
          segmentTail: tail,
          collectionPath: collection,
          memberPath,
        };
        continue;
      }

      const childDef = datasourceByName.get(child.name);
      if (!childDef) {
        throw new Error(
          `combined_routes: child "${child.name}" not found in types.yaml`,
        );
      }

      const fkColumn = findForeignKeyTo(childDef, parentName, datasourceByName);
      if (fkColumn) {
        const segment = child.route ?? defaultChildSegment(child.name);
        const tail = segment.split('/').filter(Boolean).pop() ?? '';
        const collection = `${parentBasePath}${segment}`;
        const memberPath = `${collection}/:id`;

        yield {
          kind: 'direct-fk',
          parent: parentName,
          parentBasePath,
          parentParam,
          child: { name: child.name },
          fkColumn,
          segment,
          segmentTail: tail,
          collectionPath: collection,
          memberPath,
        };
        continue;
      }

      const junction = detectJunction(parentName, child.name, datasourceByName);
      if (junction) {
        const segment = child.route ?? defaultChildSegment(child.name);
        const tail = segment.split('/').filter(Boolean).pop() ?? '';
        const collection = `${parentBasePath}${segment}`;
        const memberPath = `${collection}/:${snakeToCamel(child.name)}Id`;

        yield {
          kind: 'm2m',
          parent: parentName,
          parentBasePath,
          parentParam,
          junction: junction.name,
          target: child.name,
          targetParam: `${snakeToCamel(child.name)}Id`,
          segment,
          segmentTail: tail,
          collectionPath: collection,
          memberPath,
        };
        continue;
      }

      throw new Error(
        `combined_routes: child "${child.name}" has no FK to parent "${parentName}" and no detectable junction table in types.yaml`,
      );
    }
  }
}
