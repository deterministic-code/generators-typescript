export interface EagerChildSpec {
  fieldName: string;
  childTable: string;
  refColumn: string;
  joinTable?: string;
  joinChildColumn?: string;
  /** When true, attach only on member reads (findById + mutation returns), never on the collection list. */
  memberOnly?: boolean;
  /** False when the view field is a single nested object (`datasource_types.address`). Omitted/`true` is a collection (`address[]`). */
  isArray?: boolean;
}

export const relationIsArray = (spec: { isArray?: boolean }): boolean => spec.isArray !== false;

export const packEagerRelation = (rows: unknown[], isArray: boolean): unknown =>
  isArray ? rows : (rows[0] ?? null);

export const unpackEagerRelation = (
  value: unknown,
  isArray: boolean,
): Array<Record<string, unknown>> | undefined => {
  if (value === undefined) return undefined;
  if (isArray) {
    return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : undefined;
  }
  if (value === null) return [];
  if (typeof value === 'object' && !Array.isArray(value)) {
    return [value as Record<string, unknown>];
  }
  return undefined;
};

const withArrayFlag = <T extends object>(obj: T, isArray: boolean): T =>
  isArray ? obj : ({ ...obj, isArray: false } as T);

export type EagerLoadTree = Map<string, EagerLoadTree>;
export type EagerLoadGate = '*' | EagerLoadTree | null | undefined;

function isFieldIncluded(gate: EagerLoadGate, fieldName: string): boolean {
  if (gate === '*') return true;
  if (gate === null || gate === undefined) return false;
  return gate.has(fieldName);
}

export function subtreeFor(gate: EagerLoadGate, fieldName: string): EagerLoadGate {
  if (gate === '*') return '*';
  if (gate === null || gate === undefined) return undefined;
  return gate.get(fieldName) ?? new Map();
}

type RawField = {
  type?: string;
  references?: string;
};

type RawViewType = {
  inherits?: string;
  fields?: Array<Record<string, RawField>>;
};

type ViewTypesDoc = {
  types?: Array<Record<string, RawViewType>>;
};

type RawDatasourceType = {
  datasource_type?: string;
  inherits?: string;
  tags?: string[];
  fields?: Array<Record<string, RawField>>;
};

type DatasourceDoc = {
  types?: Array<Record<string, RawDatasourceType>>;
};

export function computeEagerChildren(
  entityName: string,
  viewTypesDoc: ViewTypesDoc | null | undefined,
  gate: EagerLoadGate,
  datasourceDoc?: DatasourceDoc | null,
): EagerChildSpec[] {
  if (gate === null || gate === undefined) return [];
  if (gate !== '*' && !(gate instanceof Map)) return [];
  if (gate !== '*' && gate.size === 0) return [];

  const viewType =
    findViewType(entityName, viewTypesDoc) ?? findViewType(entityName, datasourceDoc);
  if (!viewType) return [];

  const result: EagerChildSpec[] = [];

  const parentTable = parseInheritsTable(viewType.inherits) ?? entityName;

  for (const fieldObj of viewType.fields ?? []) {
    const [fieldName, fieldDef] = Object.entries(fieldObj)[0];

    if (!isFieldIncluded(gate, fieldName)) continue;

    const typeMatch = parseRelationType(fieldDef.type);
    if (!typeMatch) continue;

    const refMatch = parseReference(fieldDef.references);

    if (!refMatch) {
      const auto = autoDetectM2MJunction(parentTable, typeMatch.elementType, datasourceDoc);
      if (!auto) continue;
      result.push(
        withArrayFlag(
          {
            fieldName,
            childTable: typeMatch.elementType,
            refColumn: auto.parentFkColumn,
            joinTable: auto.joinTable,
            joinChildColumn: auto.childFkColumn,
          },
          typeMatch.isArray,
        ),
      );
      continue;
    }

    if (
      refMatch.table === typeMatch.elementType ||
      typeHasField(typeMatch.elementType, refMatch.column, datasourceDoc)
    ) {
      result.push(
        withArrayFlag(
          {
            fieldName,
            childTable: typeMatch.elementType,
            refColumn: refMatch.column,
          },
          typeMatch.isArray,
        ),
      );
      continue;
    }

    const joinChildColumn = findJoinChildColumn(
      refMatch.table,
      typeMatch.elementType,
      datasourceDoc,
    );
    if (!joinChildColumn) continue;

    result.push(
      withArrayFlag(
        {
          fieldName,
          childTable: typeMatch.elementType,
          refColumn: refMatch.column,
          joinTable: refMatch.table,
          joinChildColumn,
        },
        typeMatch.isArray,
      ),
    );
  }

  return result;
}

function parseInheritsTable(inherits: string | undefined): string | null {
  if (!inherits || typeof inherits !== 'string') return null;
  const prefixed = inherits.match(/^datasource_types\.([a-z_][a-z0-9_]*)$/);
  if (prefixed) return prefixed[1];
  if (/^[a-z_][a-z0-9_]*$/.test(inherits)) return inherits;
  return null;
}

function typeHasField(
  typeName: string,
  fieldName: string,
  datasourceDoc: DatasourceDoc | null | undefined,
  walking: Set<string> = new Set(),
): boolean {
  if (walking.has(typeName)) return false;
  const body = findDatasourceType(typeName, datasourceDoc);
  if (!body) return false;
  walking.add(typeName);
  if ((body.fields ?? []).some((entry) => Object.keys(entry)[0] === fieldName)) return true;
  const parent = parseInheritsTable(body.inherits);
  return parent !== null && typeHasField(parent, fieldName, datasourceDoc, walking);
}

function autoDetectM2MJunction(
  parentTable: string,
  childTable: string,
  datasourceDoc: DatasourceDoc | null | undefined,
): { joinTable: string; parentFkColumn: string; childFkColumn: string } | null {
  if (!datasourceDoc?.types) return null;
  const candidates: Array<{ joinTable: string; parentFkColumn: string; childFkColumn: string }> =
    [];
  for (const entry of datasourceDoc.types) {
    const [joinTable, def] = Object.entries(entry)[0];
    if (def.datasource_type !== 'many-to-many' && !def.tags?.includes('many_to_many')) continue;
    let parentFkColumn: string | null = null;
    let childFkColumn: string | null = null;
    for (const fieldObj of def.fields ?? []) {
      const [columnName, fieldDef] = Object.entries(fieldObj)[0];
      const refs = parseReferences(fieldDef.references);
      if (!refs) continue;
      if (refs.table === parentTable && parentFkColumn === null) parentFkColumn = columnName;
      else if (refs.table === childTable && childFkColumn === null) childFkColumn = columnName;
    }
    if (parentFkColumn && childFkColumn) {
      candidates.push({ joinTable, parentFkColumn, childFkColumn });
    }
  }
  if (candidates.length === 1) return candidates[0];
  return null;
}

function findViewType(
  entityName: string,
  viewTypesDoc: ViewTypesDoc | null | undefined,
): RawViewType | null {
  if (!viewTypesDoc || !viewTypesDoc.types) return null;
  for (const entry of viewTypesDoc.types) {
    if (entityName in entry) return entry[entityName];
  }
  return null;
}

function findDatasourceType(
  tableName: string,
  datasourceDoc: DatasourceDoc | null | undefined,
): RawDatasourceType | null {
  if (!datasourceDoc || !datasourceDoc.types) return null;
  for (const entry of datasourceDoc.types) {
    if (tableName in entry) return entry[tableName];
  }
  return null;
}

function findJoinChildColumn(
  joinTable: string,
  childTable: string,
  datasourceDoc: DatasourceDoc | null | undefined,
): string | null {
  const junction = findDatasourceType(joinTable, datasourceDoc);
  if (!junction) return null;

  for (const fieldObj of junction.fields ?? []) {
    const [columnName, fieldDef] = Object.entries(fieldObj)[0];
    const refsMatch = parseReferences(fieldDef.references);
    if (!refsMatch) continue;
    if (refsMatch.table === childTable) {
      return columnName;
    }
  }

  return null;
}

export function parseRelationType(
  typeStr: string | undefined,
): { elementType: string; isArray: boolean } | null {
  if (!typeStr || typeof typeStr !== 'string') return null;
  const prefixed = typeStr.match(/^datasource_types\.([a-z_][a-z0-9_]*)(\[\])?$/);
  if (prefixed) return { elementType: prefixed[1], isArray: prefixed[2] === '[]' };
  const unprefixed = typeStr.match(/^([a-z_][a-z0-9_]*)\[\]$/);
  if (unprefixed) return { elementType: unprefixed[1], isArray: true };
  return null;
}

function parseReference(refStr: string | undefined): { table: string; column: string } | null {
  if (!refStr || typeof refStr !== 'string') return null;
  const prefixed = refStr.match(/^datasource_types\.([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/);
  if (prefixed) return { table: prefixed[1], column: prefixed[2] };
  return parseReferences(refStr);
}

function parseReferences(refStr: string | undefined): { table: string; column: string } | null {
  if (!refStr || typeof refStr !== 'string') return null;
  const match = refStr.match(/^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/);
  if (!match) return null;
  return { table: match[1], column: match[2] };
}
