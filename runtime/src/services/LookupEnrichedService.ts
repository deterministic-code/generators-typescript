import { IEntityService } from './interfaces/IEntityService';
import { NameValue } from './interfaces/NameValue';
import { BusinessError } from '../errors/BusinessError';
import { rebindServiceToTxn } from './rebindServiceToTxn';
import type { ICrudRepository } from '../repositories/ICrudRepository';

export interface LookupMapping {
  fkField: string;
  nameField: string;
  suffixField?: string;
  replaceFk?: boolean;
  lookupService: {
    findAll(): Promise<Array<{ id: number; name: string }>>;
  };
}

/** TEXT-affinity sqlite (and string wire ids) store FK values as `"1"` / `"1.0"`; lookup rows use numeric `id`. */
export function lookupKeyOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export class LookupEnrichedService<T, TMutate = Partial<T>> implements IEntityService<
  T,
  number | string,
  TMutate
> {
  constructor(
    private readonly baseService: IEntityService<T, number | string, TMutate>,
    private readonly mappings: LookupMapping[],
  ) {}

  get primaryKey() {
    return this.baseService.primaryKey;
  }

  withTxnRepository(repo: ICrudRepository<any>): LookupEnrichedService<T, TMutate> {
    return new LookupEnrichedService(rebindServiceToTxn(this.baseService, repo), this.mappings);
  }

  async query(command: string, args: NameValue[]): Promise<T[]> {
    const items = await this.baseService.query(command, args);
    if (items.length === 0) return items;
    return this.enrichItems(items);
  }

  async findAll(): Promise<T[]> {
    const items = await this.baseService.findAll();
    if (items.length === 0) return items;
    return this.enrichItems(items);
  }

  async find(query: string, args: NameValue[]): Promise<T[]> {
    const items = await this.baseService.find(query, args);
    if (items.length === 0) return items;
    return this.enrichItems(items);
  }

  async findById(id: number | string): Promise<T | null> {
    const item = await this.baseService.findById(id);
    if (item === null) return null;
    const [enriched] = await this.enrichItems([item]);
    return enriched;
  }

  async findBy(whereArgs: NameValue[]): Promise<T[]> {
    const items = await this.baseService.findBy(whereArgs);
    if (items.length === 0) return items;
    return this.enrichItems(items);
  }

  async create(data: TMutate): Promise<T> {
    const resolved = await this.resolveInboundNames(data);
    const item = await this.baseService.create(resolved);
    const [enriched] = await this.enrichItems([item]);
    return enriched;
  }

  async update(
    id: number | string,
    data: Partial<TMutate>,
    opts?: { expectedUpdated?: string },
  ): Promise<T | null> {
    const resolved = await this.resolveInboundNames(data);
    const item =
      opts === undefined
        ? await this.baseService.update(id, resolved)
        : await this.baseService.update(id, resolved, opts);
    if (item === null) return null;
    const [enriched] = await this.enrichItems([item]);
    return enriched;
  }

  async patch(
    id: number | string,
    data: Partial<TMutate>,
    opts?: { expectedUpdated?: string },
  ): Promise<T | null> {
    return this.update(id, data, opts);
  }

  async delete(id: number | string, opts?: { expectedUpdated?: string }): Promise<boolean> {
    return opts === undefined
      ? this.baseService.delete(id)
      : this.baseService.delete(id, opts);
  }

  async updateBy(whereArgs: NameValue[], data: Partial<TMutate>): Promise<number> {
    const resolved = await this.resolveInboundNames(data);
    return this.baseService.updateBy(whereArgs, resolved);
  }

  async deleteBy(whereArgs: NameValue[]): Promise<number> {
    return this.baseService.deleteBy(whereArgs);
  }

  private async resolveInboundNames<D>(data: D): Promise<D> {
    const record = { ...data } as Record<string, unknown>;
    const inboundMappings = this.mappings.filter((m) => m.suffixField || m.replaceFk);
    if (inboundMappings.length === 0) return data;

    const inboundField = (m: LookupMapping): string => m.suffixField ?? m.nameField;

    const present = inboundMappings.filter((m) => inboundField(m) in record);
    if (present.length === 0) return data;

    const lookupMaps = await Promise.all(
      present.map(async (mapping) => {
        const lookups = await mapping.lookupService.findAll();
        const nameToId = new Map<string, number>();
        for (const lookup of lookups) {
          nameToId.set(lookup.name, lookup.id);
        }
        return { mapping, nameToId };
      }),
    );

    for (const { mapping, nameToId } of lookupMaps) {
      const field = inboundField(mapping);
      const value = record[field];

      if (value === null) {
        record[mapping.fkField] = null;
      } else if (typeof value === 'string') {
        const resolvedId = nameToId.get(value);
        if (resolvedId === undefined) {
          throw new BusinessError(400, `Invalid ${field}: '${value}'`);
        }
        record[mapping.fkField] = resolvedId;
      }

      delete record[field];
    }

    return record as D;
  }

  private async enrichItems(items: T[]): Promise<T[]> {
    const lookupMaps = await Promise.all(
      this.mappings.map(async (mapping) => {
        const lookups = await mapping.lookupService.findAll();
        const map = new Map<number, string>();
        for (const lookup of lookups) {
          const key = lookupKeyOf(lookup.id);
          if (key !== undefined) map.set(key, lookup.name);
        }
        return { mapping, map };
      }),
    );

    return items.map((item) => {
      const enriched = { ...item } as Record<string, unknown>;
      for (const { mapping, map } of lookupMaps) {
        const fkValue = enriched[mapping.fkField];
        const target = mapping.suffixField ?? mapping.nameField;
        if (fkValue === null || fkValue === undefined) {
          enriched[target] = fkValue === null ? null : undefined;
        } else {
          const key = lookupKeyOf(fkValue);
          enriched[target] = key === undefined ? undefined : map.get(key);
        }
        if (mapping.replaceFk && !mapping.suffixField) {
          delete enriched[mapping.fkField];
        }
      }
      return enriched as T;
    });
  }
}
