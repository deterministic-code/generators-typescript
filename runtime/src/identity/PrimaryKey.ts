import type { StandardIdType } from './standardIdType';
import type { RouteIdType } from '../routes/routeParamUtils';

const ID_TYPES: readonly StandardIdType[] = ['integer', 'biginteger', 'uuid', 'string'];

/**
 * Per-entity primary key: column name and {@link StandardIdType}, plus how to
 * address it in a route and read/compare it on a row.
 */
export class PrimaryKey {
  constructor(
    readonly column: string,
    readonly idType: StandardIdType,
  ) {
    if (!column) {
      throw new Error('invariant: PrimaryKey requires a column (from the entity primary_key)');
    }
    if (!ID_TYPES.includes(idType)) {
      throw new Error(
        `invariant: PrimaryKey requires an id_type resolved from settings, got ${JSON.stringify(idType)}`,
      );
    }
  }

  get routeIdType(): RouteIdType {
    return this.idType === 'biginteger' ? 'integer' : this.idType;
  }

  routeSegment(paramName: string = this.column): string {
    return `/:${paramName}`;
  }

  valueOf(row: Record<string, unknown>): unknown {
    return row[this.column];
  }

  matches(row: Record<string, unknown>, id: number | string): boolean {
    return row[this.column] === id;
  }

  bodyFieldType(): 'number' | 'string' {
    return this.routeIdType === 'integer' ? 'number' : 'string';
  }
}
