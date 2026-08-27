import type { ITypeFieldConverter } from '../converters/ITypeFieldConverter';
import { getMappedTableName, inheritOf } from './getMappedTableName';
import {
  parseAllMappings,
  getEntityFieldMap,
  type EntityFieldMap,
  type FieldMappings,
} from './parseFieldMappings';

export interface NameMapper {
  tableFor(entityName: string): string;
  fieldsFor(entityName: string): EntityFieldMap;
  convertersFor(entityName: string): EntityFieldMap;
}

export function createNameMapper(
  spec: unknown,
  pluralizeTableNames = false,
  typesDoc?: unknown,
): NameMapper {
  const { renames, converters } = parseAllMappings(spec);
  return {
    tableFor: (entityName) =>
      getMappedTableName(spec, entityName, pluralizeTableNames, typesDoc),
    fieldsFor: (entityName) =>
      inheritFieldMap(renames, entityName, typesDoc ?? spec),
    convertersFor: (entityName) =>
      inheritFieldMap(converters, entityName, typesDoc ?? spec),
  };
}

function inheritFieldMap(
  mappings: FieldMappings,
  entityName: string,
  typesDoc: unknown,
): EntityFieldMap {
  const merged = new Map<string, string>();
  const seen = new Set<string>();
  let current: string | undefined = entityName;
  const chain: string[] = [];
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = inheritOf(typesDoc, current);
  }
  for (const name of chain.reverse()) {
    for (const [logical, physical] of getEntityFieldMap(mappings, name)) {
      merged.set(logical, physical);
    }
  }
  return merged;
}

export function resolveFieldConverters(
  converterNames: EntityFieldMap,
  customConverters: ReadonlyMap<string, ITypeFieldConverter> | undefined,
  entityName: string,
): ReadonlyMap<string, ITypeFieldConverter> | undefined {
  if (converterNames.size === 0) return undefined;
  const resolved = new Map<string, ITypeFieldConverter>();
  for (const [column, name] of converterNames) {
    const converter = customConverters?.get(name);
    if (!converter) {
      throw new Error(
        `resolveFieldConverters: entity '${entityName}' field '${column}' declares type_converter '${name}', but no converter with that name was supplied via customConverters`,
      );
    }
    resolved.set(column, converter);
  }
  return resolved;
}
