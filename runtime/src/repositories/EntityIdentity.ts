import { PrimaryKey } from './PrimaryKey';

export type IdentityScalar = number | string;
export type IdentityRecord = Record<string, IdentityScalar>;
export type IdentityValue = IdentityScalar | IdentityRecord;

const isRecord = (value: unknown): value is IdentityRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Ordered identity for one entity: one {@link PrimaryKey} per column, spec `ids` order.
 * A single-column identity still exposes {@link column} / {@link idType} so existing
 * call sites keep working. Composite find/update/delete take a named record.
 */
export class EntityIdentity {
  constructor(readonly keys: readonly PrimaryKey[]) {
    if (keys.length === 0) {
      throw new Error('invariant: EntityIdentity requires at least one PrimaryKey');
    }
  }

  static of(keys: readonly PrimaryKey[]): EntityIdentity {
    return new EntityIdentity(keys);
  }

  static scalar(column: string, idType: PrimaryKey['idType']): EntityIdentity {
    return new EntityIdentity([new PrimaryKey(column, idType)]);
  }

  get column(): string {
    return this.keys[0]!.column;
  }

  get idType(): PrimaryKey['idType'] {
    return this.keys[0]!.idType;
  }

  get routeIdType(): PrimaryKey['routeIdType'] {
    return this.keys[0]!.routeIdType;
  }

  get isComposite(): boolean {
    return this.keys.length > 1;
  }

  columns(): readonly string[] {
    return this.keys.map((k) => k.column);
  }

  routeSegment(paramName: string = this.column): string {
    return this.keys[0]!.routeSegment(paramName);
  }

  routeSegments(): string {
    return this.keys.map((k) => k.routeSegment()).join('');
  }

  bodyFieldType(): 'number' | 'string' {
    return this.keys[0]!.bodyFieldType();
  }

  normalize(id: IdentityValue): IdentityRecord {
    if (isRecord(id)) {
      const expected = this.columns();
      const extra = Object.keys(id).filter((k) => !expected.includes(k));
      if (extra.length > 0) {
        throw new Error(
          `invariant: unexpected identity key${extra.length === 1 ? '' : 's'} ${extra.map((k) => `"${k}"`).join(', ')}`,
        );
      }
      for (const column of expected) {
        if (id[column] === undefined) {
          throw new Error(`invariant: missing identity key "${column}"`);
        }
      }
      return id;
    }
    if (this.isComposite) {
      throw new Error('invariant: composite identity requires a named record');
    }
    return { [this.column]: id };
  }

  fromRow(row: Record<string, unknown>): IdentityValue {
    if (!this.isComposite) return this.keys[0]!.valueOf(row) as IdentityScalar;
    const out: IdentityRecord = {};
    for (const key of this.keys) {
      out[key.column] = key.valueOf(row) as IdentityScalar;
    }
    return out;
  }

  valueOf(row: Record<string, unknown>): unknown {
    return this.fromRow(row);
  }

  matches(row: Record<string, unknown>, id: IdentityValue): boolean {
    const rec = this.normalize(id);
    return this.keys.every((k) => row[k.column] === rec[k.column]);
  }

  format(id: IdentityValue): string {
    if (isRecord(id)) {
      return this.keys.map((k) => String(id[k.column])).join('/');
    }
    return String(id);
  }

  orderBySql(quote: (column: string) => string): string {
    return this.keys.map((k) => `${quote(k.column)} ASC`).join(', ');
  }

  whereEqual(
    id: IdentityValue,
    quote: (column: string) => string,
    placeholder: (index: number) => string,
    applyTo: (column: string, value: unknown) => unknown,
    startIndex = 0,
  ): { sql: string; values: unknown[] } {
    const rec = this.normalize(id);
    return {
      sql: this.keys
        .map((k, i) => `${quote(k.column)} = ${placeholder(startIndex + i)}`)
        .join(' AND '),
      values: this.keys.map((k) => applyTo(k.column, rec[k.column])),
    };
  }
}
