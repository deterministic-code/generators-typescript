import type { IDatasourceNaming } from '@deterministic-code/generators-common/datasource-naming';
import type { EntityFieldMap } from './parseFieldMappings';

export class FieldMappingTranslator {
  private readonly overlays: ReadonlyMap<string, string>;
  private readonly physicalToLogical: ReadonlyMap<string, string>;
  private readonly naming: IDatasourceNaming;
  readonly hasMappings: boolean;

  constructor(entityMap: EntityFieldMap | undefined, naming: IDatasourceNaming) {
    this.naming = naming;
    this.overlays = entityMap ?? new Map();
    this.hasMappings = this.overlays.size > 0;
    const reverse = new Map<string, string>();
    for (const [logical, overlay] of this.overlays) {
      const physical = naming.resolveColumn(logical, overlay);
      if (reverse.has(physical)) {
        throw new Error(
          `FieldMappingTranslator: physical column '${physical}' is mapped from multiple logical columns ('${reverse.get(physical)}' and '${logical}')`,
        );
      }
      reverse.set(physical, logical);
    }
    this.physicalToLogical = reverse;
  }

  toPhysical(logical: string): string {
    return this.naming.resolveColumn(logical, this.overlays.get(logical));
  }

  toLogical(physical: string): string {
    return this.physicalToLogical.get(physical) ?? physical;
  }

  toPhysicalRow<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
    if (!this.hasMappings) return row;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[this.toPhysical(k)] = v;
    }
    return out;
  }

  toLogicalRow<T extends Record<string, unknown>>(row: T): T {
    if (!this.hasMappings) return row;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[this.toLogical(k)] = v;
    }
    return out as T;
  }
}
