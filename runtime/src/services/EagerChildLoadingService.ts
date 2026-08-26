import { IEntityService } from './interfaces/IEntityService';
import { NameValue } from './interfaces/NameValue';
import {
  EagerChildSpec,
  packEagerRelation,
  relationIsArray,
} from '../app/loaders/computeEagerChildren';
import { rebindServiceToTxn } from './rebindServiceToTxn';
import type { ICrudRepository } from '../repositories/ICrudRepository';

type LooseService = IEntityService<any>;

function toNameValues(name: string, values: ReadonlyArray<unknown>): NameValue[] {
  return values.map((v) => ({ name, value: v }));
}

function toSingleNameValue(name: string, value: unknown): NameValue[] {
  return [{ name, value }];
}

export class EagerChildLoadingService<T, TMutate = Partial<T>> implements IEntityService<
  T,
  number | string,
  TMutate
> {
  constructor(
    private readonly base: IEntityService<T, number | string, TMutate>,
    private readonly children: EagerChildSpec[],
    private readonly childServices: Map<string, LooseService>,
    private readonly joinServices: Map<string, LooseService> = new Map(),
    private readonly rawChildServices: Map<string, LooseService> = new Map(),
  ) {}

  private get collectionChildren(): EagerChildSpec[] {
    return this.children.filter((c) => c.memberOnly !== true);
  }

  get primaryKey() {
    return this.base.primaryKey;
  }

  withTxnRepository(repo: ICrudRepository<any>): EagerChildLoadingService<T, TMutate> {
    return new EagerChildLoadingService(
      rebindServiceToTxn(this.base, repo),
      this.children,
      this.childServices,
      this.joinServices,
      this.rawChildServices,
    );
  }

  async query(command: string, args: NameValue[]): Promise<T[]> {
    const items = await this.base.query(command, args);
    if (items.length === 0) return items;
    return this.attachChildrenBatched(items, this.collectionChildren);
  }

  async findById(id: number | string): Promise<T | null> {
    const item = await this.base.findById(id);
    if (item === null) return null;
    return this.attachChildren(item);
  }

  async findAll(): Promise<T[]> {
    const items = await this.base.findAll();
    if (items.length === 0) return items;
    return this.attachChildrenBatched(items, this.collectionChildren);
  }

  async find(query: string, args: NameValue[]): Promise<T[]> {
    const items = await this.base.find(query, args);
    if (items.length === 0) return items;
    return this.attachChildrenBatched(items, this.collectionChildren);
  }

  async findBy(whereArgs: NameValue[]): Promise<T[]> {
    const items = await this.base.findBy(whereArgs);
    if (items.length === 0) return items;
    return this.attachChildrenBatched(items, this.collectionChildren);
  }

  async create(data: TMutate): Promise<T> {
    const item = await this.base.create(data);
    const itemRecord = item as Record<string, unknown>;
    for (const spec of this.children) {
      if (!this.hasResolvableServices(spec)) continue;
      itemRecord[spec.fieldName] = packEagerRelation([], relationIsArray(spec));
    }
    return itemRecord as T;
  }

  async update(
    id: number | string,
    data: Partial<TMutate>,
    opts?: { expectedUpdated?: string },
  ): Promise<T | null> {
    const item =
      opts === undefined ? await this.base.update(id, data) : await this.base.update(id, data, opts);
    if (item === null) return null;
    return this.attachChildren(item);
  }

  async patch(
    id: number | string,
    data: Partial<TMutate>,
    opts?: { expectedUpdated?: string },
  ): Promise<T | null> {
    return this.update(id, data, opts);
  }

  async delete(id: number | string, opts?: { expectedUpdated?: string }): Promise<boolean> {
    return opts === undefined ? this.base.delete(id) : this.base.delete(id, opts);
  }

  async updateBy(whereArgs: NameValue[], data: Partial<TMutate>): Promise<number> {
    return this.base.updateBy(whereArgs, data);
  }

  async deleteBy(whereArgs: NameValue[]): Promise<number> {
    return this.base.deleteBy(whereArgs);
  }

  private hasResolvableServices(spec: EagerChildSpec): boolean {
    if (!this.childServices.has(spec.childTable)) return false;
    if (spec.joinTable && !this.joinServices.has(spec.joinTable)) return false;
    return true;
  }

  private async attachChildren(item: T): Promise<T> {
    if (this.children.length === 0) {
      return item;
    }

    const itemRecord = item as Record<string, unknown>;

    const attachPromises = this.children.map(async (spec) => {
      if (!this.hasResolvableServices(spec)) return;

      if (spec.joinTable && spec.joinChildColumn) {
        const childRows = await this.fetchM2MChildrenSingle(spec, itemRecord.id);
        itemRecord[spec.fieldName] = packEagerRelation(childRows, relationIsArray(spec));
        return;
      }

      const childService = this.childServices.get(spec.childTable)!;
      const childRows = await childService.findBy(toSingleNameValue(spec.refColumn, itemRecord.id));
      itemRecord[spec.fieldName] = packEagerRelation(childRows, relationIsArray(spec));
    });

    await Promise.all(attachPromises);
    return itemRecord as T;
  }

  private async fetchM2MChildrenSingle(
    spec: EagerChildSpec,
    parentId: unknown,
  ): Promise<unknown[]> {
    const joinService = this.joinServices.get(spec.joinTable!)!;
    const childService = this.childServices.get(spec.childTable)!;

    const junctionRows = await joinService.findBy(toSingleNameValue(spec.refColumn, parentId));
    if (junctionRows.length === 0) return [];

    const childIds = uniquePreserveOrder(
      junctionRows.map((r) => (r as Record<string, unknown>)[spec.joinChildColumn!]),
    );
    const children = await childService.findBy(toNameValues('id', childIds));

    const childById = new Map<unknown, unknown>();
    for (const child of children) {
      childById.set((child as Record<string, unknown>).id, child);
    }

    const result: unknown[] = [];
    for (const id of childIds) {
      const c = childById.get(id);
      if (c !== undefined) result.push(c);
    }
    return result;
  }

  private async attachChildrenBatched(items: T[], children: EagerChildSpec[]): Promise<T[]> {
    if (children.length === 0 || items.length === 0) {
      return items;
    }

    const parentIds = items.map((i) => (i as Record<string, unknown>).id);

    const batchedChildren = await Promise.all(
      children.map(async (spec) => {
        if (!this.hasResolvableServices(spec)) {
          return { spec, grouped: new Map<unknown, unknown[]>() };
        }

        if (spec.joinTable && spec.joinChildColumn) {
          return { spec, grouped: await this.fetchM2MChildrenBatched(spec, parentIds) };
        }

        return { spec, grouped: await this.fetchDirectFKChildrenBatched(spec, parentIds) };
      }),
    );

    for (const item of items) {
      const itemRecord = item as Record<string, unknown>;
      for (const { spec, grouped } of batchedChildren) {
        if (!this.hasResolvableServices(spec)) continue;
        itemRecord[spec.fieldName] = packEagerRelation(
          grouped.get(itemRecord.id) ?? [],
          relationIsArray(spec),
        );
      }
    }

    return items;
  }

  private async fetchDirectFKChildrenBatched(
    spec: EagerChildSpec,
    parentIds: ReadonlyArray<unknown>,
  ): Promise<Map<unknown, unknown[]>> {
    const enrichedService = this.childServices.get(spec.childTable)!;
    const rawService = this.rawChildServices.get(spec.childTable);

    if (!rawService || rawService === enrichedService) {
      const grouped = new Map<unknown, unknown[]>();
      const childRows = await enrichedService.findBy(toNameValues(spec.refColumn, parentIds));
      for (const row of childRows) {
        const rowRecord = row as Record<string, unknown>;
        if (!(spec.refColumn in rowRecord)) {
          throw new Error(
            `EagerChildLoadingService: child row of "${spec.childTable}" is missing FK column "${spec.refColumn}" used to group by parent. ` +
              `This usually means the child service strips the FK during enrichment (e.g. LookupEnrichedService with replaceFk=true / auto_enrich=true). ` +
              `Pass a raw child service (one whose findBy preserves "${spec.refColumn}") so eager-loading can group by FK and then fetch the enriched rows by id.`,
          );
        }
        const refValue = rowRecord[spec.refColumn];
        if (!grouped.has(refValue)) {
          grouped.set(refValue, []);
        }
        grouped.get(refValue)!.push(row);
      }
      return grouped;
    }

    const rawRows = await rawService.findBy(toNameValues(spec.refColumn, parentIds));
    const grouped = new Map<unknown, unknown[]>();
    if (rawRows.length === 0) return grouped;

    const idsByParent = new Map<unknown, unknown[]>();
    const allChildIds: unknown[] = [];
    const seenChildIds = new Set<unknown>();
    for (const row of rawRows) {
      const rowRecord = row as Record<string, unknown>;
      if (!(spec.refColumn in rowRecord)) {
        throw new Error(
          `EagerChildLoadingService: raw child service for "${spec.childTable}" must preserve FK column "${spec.refColumn}" but did not.`,
        );
      }
      const parentId = rowRecord[spec.refColumn];
      const childId = rowRecord.id;
      const bucket = idsByParent.get(parentId);
      if (bucket) {
        bucket.push(childId);
      } else {
        idsByParent.set(parentId, [childId]);
      }
      if (!seenChildIds.has(childId)) {
        seenChildIds.add(childId);
        allChildIds.push(childId);
      }
    }

    const enrichedRows = await enrichedService.findBy(toNameValues('id', allChildIds));
    const enrichedById = new Map<unknown, unknown>();
    for (const row of enrichedRows) {
      enrichedById.set((row as Record<string, unknown>).id, row);
    }

    for (const [parentId, childIds] of idsByParent) {
      const list: unknown[] = [];
      for (const id of childIds) {
        const enriched = enrichedById.get(id);
        if (enriched !== undefined) list.push(enriched);
      }
      grouped.set(parentId, list);
    }
    return grouped;
  }

  private async fetchM2MChildrenBatched(
    spec: EagerChildSpec,
    parentIds: ReadonlyArray<unknown>,
  ): Promise<Map<unknown, unknown[]>> {
    const joinService = this.joinServices.get(spec.joinTable!)!;
    const childService = this.childServices.get(spec.childTable)!;

    const grouped = new Map<unknown, unknown[]>();
    const junctionRows = await joinService.findBy(toNameValues(spec.refColumn, parentIds));
    if (junctionRows.length === 0) return grouped;

    const childIdsByParent = new Map<unknown, unknown[]>();
    const allChildIds: unknown[] = [];
    const seenChildIds = new Set<unknown>();
    for (const row of junctionRows) {
      const rowRecord = row as Record<string, unknown>;
      const parentId = rowRecord[spec.refColumn];
      const childId = rowRecord[spec.joinChildColumn!];
      if (!childIdsByParent.has(parentId)) childIdsByParent.set(parentId, []);
      childIdsByParent.get(parentId)!.push(childId);
      if (!seenChildIds.has(childId)) {
        seenChildIds.add(childId);
        allChildIds.push(childId);
      }
    }

    const children = await childService.findBy(toNameValues('id', allChildIds));
    const childById = new Map<unknown, unknown>();
    for (const child of children) {
      childById.set((child as Record<string, unknown>).id, child);
    }

    for (const [parentId, childIds] of childIdsByParent) {
      const list: unknown[] = [];
      for (const id of childIds) {
        const c = childById.get(id);
        if (c !== undefined) list.push(c);
      }
      grouped.set(parentId, list);
    }
    return grouped;
  }
}

function uniquePreserveOrder<T>(values: ReadonlyArray<T>): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
