interface DatasourceFieldDef {
  type?: string;
  references?: string;
  [key: string]: unknown;
}

export interface DatasourceTypeDef {
  datasource_type?: string;
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

export function findForeignKeyTo(childDef: DatasourceTypeDef, parentName: string): string | null {
  const fields = Array.isArray(childDef?.fields) ? childDef.fields : [];
  for (const f of fields) {
    const [fname, fdef] = Object.entries(f)[0];
    if (fdef && typeof fdef.references === 'string') {
      const [refTable] = fdef.references.split('.');
      if (refTable === parentName) return fname;
    }
  }
  return null;
}

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
    const parentFk = findForeignKeyTo(def, parentName);
    const childFk = findForeignKeyTo(def, childName);
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

    for (const rawChild of def.combined_types ?? []) {
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

      const fkColumn = findForeignKeyTo(childDef, parentName);
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
