import type { IDatasource } from '../repositories/IDatasource';
import type { ICrudRepository } from '../repositories/ICrudRepository';
import { ValidationError } from '../errors/AppError';
import { IEntityService } from './interfaces/IEntityService';
import { NameValue } from './interfaces/NameValue';
import { rebindServiceToTxn } from './rebindServiceToTxn';
import {
  packEagerRelation,
  relationIsArray,
  unpackEagerRelation,
} from '../app/loaders/computeEagerChildren';

export type EagerWriteChildBinding = EagerWriteDirectFkBinding | EagerWriteM2MBinding;

interface EagerWriteDirectFkBinding {
  /** Discriminator. Optional for backward-compat (undefined === 'direct-fk'). */
  kind?: 'direct-fk';
  fieldName: string;
  childTable: string;
  fkColumn: string;
  service: IEntityService<any>;
  repository: ICrudRepository<any>;
  withTxnRepoFn: (repo: ICrudRepository<any>, txn: IDatasource) => ICrudRepository<any>;
  /** Nested eager-write bindings whose parent is each row of this child. */
  children?: EagerWriteChildBinding[];
  /** False when the view field is a single nested object. Omitted/`true` is a collection. */
  isArray?: boolean;
}

export interface EagerWriteM2MBinding {
  kind: 'm2m';
  fieldName: string;
  /** The M2M target table (e.g. 'tag' for post.tags). */
  childTable: string;
  /** The junction table (e.g. 'post_tag'). */
  junctionTable: string;
  /** Junction column referencing the parent (e.g. 'post_id'). */
  parentFkColumn: string;
  /** Junction column referencing the target (e.g. 'tag_id'). */
  targetFkColumn: string;
  /** Service for the target table. */
  service: IEntityService<any>;
  /** Raw repository for the target table. */
  repository: ICrudRepository<any>;
  /** Raw repository for the junction table. */
  junctionRepository: ICrudRepository<any>;
  withTxnRepoFn: (repo: ICrudRepository<any>, txn: IDatasource) => ICrudRepository<any>;
  /** Nested eager-write bindings whose parent is the linked target row. */
  children?: EagerWriteChildBinding[];
  /** False when the view field is a single nested object. Omitted/`true` is a collection. */
  isArray?: boolean;
}

function isM2MBinding(b: EagerWriteChildBinding): b is EagerWriteM2MBinding {
  return b.kind === 'm2m';
}

export interface EagerChildWritingServiceDeps<T, TMutate> {
  base: IEntityService<T, number | string, TMutate>;
  datasource: IDatasource;
  parentRepository: ICrudRepository<T & { id: number }>;
  parentWithTxnRepoFn: (
    repo: ICrudRepository<T & { id: number }>,
    txn: IDatasource,
  ) => ICrudRepository<T & { id: number }>;
  children: EagerWriteChildBinding[];
}

type Mode = 'create' | 'update' | 'patch';

export class EagerChildWritingService<T, TMutate = Partial<T>> implements IEntityService<
  T,
  number | string,
  TMutate
> {
  constructor(private readonly deps: EagerChildWritingServiceDeps<T, TMutate>) {}

  get primaryKey() {
    return this.deps.base.primaryKey;
  }

  async query(command: string, args: NameValue[]): Promise<T[]> {
    return this.deps.base.query(command, args);
  }

  async findAll(): Promise<T[]> {
    return this.deps.base.findAll();
  }

  async find(query: string, args: NameValue[]): Promise<T[]> {
    return this.deps.base.find(query, args);
  }

  async findById(id: number | string): Promise<T | null> {
    return this.deps.base.findById(id);
  }

  async findBy(whereArgs: NameValue[]): Promise<T[]> {
    return this.deps.base.findBy(whereArgs);
  }

  async create(data: TMutate): Promise<T> {
    this.validateRowsRecursively(data as Record<string, unknown>, this.deps.children, 'create');
    const { base: parentData } = splitRow(data as Record<string, unknown>, this.deps.children);

    return this.deps.datasource.runInTransaction(async (txn) => {
      const txnParentRepo = this.deps.parentWithTxnRepoFn(this.deps.parentRepository, txn);
      const txnParentService = this.cloneService(this.deps.base, txnParentRepo);

      const createdParent = await txnParentService.create(parentData as any);
      const parentId = (createdParent as { id: number }).id;
      const responseParent = { ...createdParent } as T;

      const reconciled = await this.processBindingsForParent(
        this.deps.children,
        parentId,
        data as Record<string, unknown>,
        txn,
        'create',
      );
      Object.assign(responseParent as object, reconciled);
      return responseParent;
    });
  }

  async update(
    id: number | string,
    data: Partial<TMutate>,
    opts?: { expectedUpdated?: string },
  ): Promise<T | null> {
    this.validateRowsRecursively(data as Record<string, unknown>, this.deps.children, 'update');
    const { base: parentData } = splitRow(data as Record<string, unknown>, this.deps.children);

    return this.deps.datasource.runInTransaction(async (txn) => {
      const txnParentRepo = this.deps.parentWithTxnRepoFn(this.deps.parentRepository, txn);
      const txnParentService = this.cloneService(this.deps.base, txnParentRepo);

      const existingParent = await txnParentService.findById(id);
      if (existingParent === null) return null;

      const updatedParent =
        Object.keys(parentData).length > 0
          ? opts === undefined
            ? await txnParentService.update(id, parentData as any)
            : await txnParentService.update(id, parentData as any, opts)
          : existingParent;
      if (updatedParent === null) return null;

      const parentId = (updatedParent as { id: number }).id;
      const responseParent = { ...updatedParent } as T;

      const reconciled = await this.processBindingsForParent(
        this.deps.children,
        parentId,
        data as Record<string, unknown>,
        txn,
        'update',
      );
      Object.assign(responseParent as object, reconciled);
      return responseParent;
    });
  }

  async patch(
    id: number | string,
    data: Partial<TMutate>,
    opts?: { expectedUpdated?: string },
  ): Promise<T | null> {
    this.validateRowsRecursively(data as Record<string, unknown>, this.deps.children, 'patch');
    const { base: parentData } = splitRow(data as Record<string, unknown>, this.deps.children);

    return this.deps.datasource.runInTransaction(async (txn) => {
      const txnParentRepo = this.deps.parentWithTxnRepoFn(this.deps.parentRepository, txn);
      const txnParentService = this.cloneService(this.deps.base, txnParentRepo);

      const existingParent = await txnParentService.findById(id);
      if (existingParent === null) return null;

      const updatedParent =
        Object.keys(parentData).length > 0
          ? opts === undefined
            ? await txnParentService.update(id, parentData as any)
            : await txnParentService.update(id, parentData as any, opts)
          : existingParent;
      if (updatedParent === null) return null;

      const parentId = (updatedParent as { id: number }).id;
      const responseParent = { ...updatedParent } as T;

      const reconciled = await this.processBindingsForParent(
        this.deps.children,
        parentId,
        data as Record<string, unknown>,
        txn,
        'patch',
      );
      Object.assign(responseParent as object, reconciled);
      return responseParent;
    });
  }

  async delete(id: number | string, opts?: { expectedUpdated?: string }): Promise<boolean> {
    return this.deps.datasource.runInTransaction(async (txn) => {
      await this.deleteChildrenForParent(this.deps.children, id, txn);
      const txnParentRepo = this.deps.parentWithTxnRepoFn(this.deps.parentRepository, txn);
      const txnParentService = this.cloneService(this.deps.base, txnParentRepo);
      return opts === undefined
        ? txnParentService.delete(id)
        : txnParentService.delete(id, opts);
    });
  }

  private async deleteChildrenForParent(
    bindings: EagerWriteChildBinding[],
    parentId: number | string,
    txn: IDatasource,
  ): Promise<void> {
    // why reverse: deletes mirror create order so FK ordering inverts the build order.
    for (let i = bindings.length - 1; i >= 0; i--) {
      const binding = bindings[i];
      if (isM2MBinding(binding)) {
        const txnJunctionRepo = binding.withTxnRepoFn(binding.junctionRepository, txn);
        await txnJunctionRepo.deleteBy(binding.parentFkColumn, parentId);
        continue;
      }
      const fkColumn = binding.fkColumn;
      const txnChildRepo = binding.withTxnRepoFn(binding.repository, txn);
      const txnChildService = this.cloneService(binding.service, txnChildRepo);
      const existing = await txnChildService.findBy([{ name: fkColumn, value: String(parentId) }]);
      const nested = binding.children ?? [];
      for (let j = existing.length - 1; j >= 0; j--) {
        const childId = (existing[j] as { id: number | string }).id;
        if (nested.length > 0) {
          await this.deleteChildrenForParent(nested, childId, txn);
        }
        await txnChildService.delete(childId);
      }
    }
  }

  async updateBy(whereArgs: NameValue[], data: Partial<TMutate>): Promise<number> {
    return this.deps.base.updateBy(whereArgs, data);
  }

  async deleteBy(whereArgs: NameValue[]): Promise<number> {
    return this.deps.base.deleteBy(whereArgs);
  }

  // Recursive walker

  /**
   * Reconcile every binding in `bindings` against the corresponding fields in
   * `parentIncomingRow`, treating `parentId` as the FK parent. Returns
   * `{ [fieldName]: reconciled[] | object | null }` for each binding processed.
   * Mutually recursive with `processOneRow` via `binding.children`.
   */
  private async processBindingsForParent(
    bindings: EagerWriteChildBinding[],
    parentId: number,
    parentIncomingRow: Record<string, unknown>,
    txn: IDatasource,
    mode: Mode,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const binding of bindings) {
      const isArray = relationIsArray(binding);
      const childRows = unpackEagerRelation(parentIncomingRow[binding.fieldName], isArray);

      if (mode === 'create') {
        if (childRows === undefined) {
          out[binding.fieldName] = packEagerRelation([], isArray);
          continue;
        }
        out[binding.fieldName] = packEagerRelation(
          await this.createChildArray(binding, parentId, childRows, txn),
          isArray,
        );
        continue;
      }

      // update / patch
      if (childRows === undefined) {
        out[binding.fieldName] = packEagerRelation(
          await this.loadExistingFor(binding, parentId, txn),
          isArray,
        );
        continue;
      }
      out[binding.fieldName] = packEagerRelation(
        await this.reconcileChildArray(binding, parentId, childRows, txn, mode),
        isArray,
      );
    }
    return out;
  }

  private async createChildArray(
    binding: EagerWriteChildBinding,
    parentId: number,
    childRows: Array<Record<string, unknown>>,
    txn: IDatasource,
  ): Promise<unknown[]> {
    const nested = binding.children ?? [];
    if (isM2MBinding(binding)) {
      const txnTargetService = this.cloneService(
        binding.service,
        binding.withTxnRepoFn(binding.repository, txn),
      );
      const txnJunctionRepo = binding.withTxnRepoFn(binding.junctionRepository, txn);

      const result: unknown[] = [];
      for (const row of childRows) {
        const { base, nestedFields } = splitRow(row, nested);
        const targetId = await this.resolveOrCreateTargetId(base, txnTargetService);
        await txnJunctionRepo.add({
          [binding.parentFkColumn]: parentId,
          [binding.targetFkColumn]: targetId,
        } as any);
        const target = await txnTargetService.findById(targetId);
        if (target === null) continue;
        const enriched = { ...target };
        if (nested.length > 0) {
          const nestedReconciled = await this.processBindingsForParent(
            nested,
            targetId,
            nestedFields,
            txn,
            'create',
          );
          Object.assign(enriched, nestedReconciled);
        }
        result.push(enriched);
      }
      return result;
    }

    const fkColumn = binding.fkColumn;
    const txnChildService = this.cloneService(
      binding.service,
      binding.withTxnRepoFn(binding.repository, txn),
    );
    const result: unknown[] = [];
    for (const row of childRows) {
      const { base, nestedFields } = splitRow(row, nested);
      base[fkColumn] = parentId;
      const created = await txnChildService.create(base as any);
      const childId = (created as { id: number }).id;
      const enriched = { ...created };
      if (nested.length > 0) {
        const nestedReconciled = await this.processBindingsForParent(
          nested,
          childId,
          nestedFields,
          txn,
          'create',
        );
        Object.assign(enriched, nestedReconciled);
      }
      result.push(enriched);
    }
    return result;
  }

  private async reconcileChildArray(
    binding: EagerWriteChildBinding,
    parentId: number,
    childRows: Array<Record<string, unknown>>,
    txn: IDatasource,
    mode: Mode,
  ): Promise<unknown[]> {
    const nested = binding.children ?? [];

    if (isM2MBinding(binding)) {
      const txnTargetRepo = binding.withTxnRepoFn(binding.repository, txn);
      const txnTargetService = this.cloneService(binding.service, txnTargetRepo);
      const txnJunctionRepo = binding.withTxnRepoFn(binding.junctionRepository, txn);

      const existingJunctions = (await txnJunctionRepo.findBy(
        binding.parentFkColumn,
        parentId,
      )) as Array<{ id: number; [k: string]: unknown }>;
      const existingTargetIds = new Set<number>(
        existingJunctions.map((j) => j[binding.targetFkColumn] as number),
      );

      // Map incoming row → resolvedTargetId (preserving order so we recurse with the right row).
      const resolved: Array<{ row: Record<string, unknown>; targetId: number }> = [];
      const incomingTargetIds = new Set<number>();
      for (const row of childRows) {
        const { base } = splitRow(row, nested);
        const targetId = await this.resolveOrCreateTargetId(base, txnTargetService);
        incomingTargetIds.add(targetId);
        if (!existingTargetIds.has(targetId)) {
          await txnJunctionRepo.add({
            [binding.parentFkColumn]: parentId,
            [binding.targetFkColumn]: targetId,
          } as any);
        }
        resolved.push({ row, targetId });
      }

      for (const j of existingJunctions) {
        const tid = j[binding.targetFkColumn] as number;
        if (!incomingTargetIds.has(tid)) {
          await txnJunctionRepo.delete(j.id);
        }
      }

      const result: unknown[] = [];
      for (const { row, targetId } of resolved) {
        const target = await txnTargetService.findById(targetId);
        if (target === null) continue;
        const enriched = { ...target };
        if (nested.length > 0) {
          const { nestedFields } = splitRow(row, nested);
          const nestedReconciled = await this.processBindingsForParent(
            nested,
            targetId,
            nestedFields,
            txn,
            mode,
          );
          Object.assign(enriched, nestedReconciled);
        }
        result.push(enriched);
      }
      return result;
    }

    const fkColumn = binding.fkColumn;
    const txnChildRepo = binding.withTxnRepoFn(binding.repository, txn);
    const txnChildService = this.cloneService(binding.service, txnChildRepo);

    const existing = await txnChildService.findBy([{ name: fkColumn, value: String(parentId) }]);

    const incomingIds = new Set<number>();
    type RowOp =
      | {
          kind: 'update';
          childId: number;
          data: Record<string, unknown>;
          nestedFields: Record<string, unknown>;
        }
      | { kind: 'create'; data: Record<string, unknown>; nestedFields: Record<string, unknown> };
    const ops: RowOp[] = [];

    for (const row of childRows) {
      const { base, nestedFields } = splitRow(row, nested);
      const childId = base.id as number | undefined;
      if (childId !== undefined) {
        const existingChild = existing.find((c) => (c as { id: number }).id === childId);
        if (!existingChild) {
          throw new ValidationError(
            `cross-parent guard: child id ${childId} does not belong to this parent`,
          );
        }
        incomingIds.add(childId);
        const { id: _id, ...dataWithoutId } = base;
        ops.push({ kind: 'update', childId, data: dataWithoutId, nestedFields });
      } else {
        base[fkColumn] = parentId;
        ops.push({ kind: 'create', data: base, nestedFields });
      }
    }

    for (const existingChild of existing) {
      const existingId = (existingChild as { id: number }).id;
      if (!incomingIds.has(existingId)) {
        if (nested.length > 0) {
          await this.deleteChildrenForParent(nested, existingId, txn);
        }
        await txnChildService.delete(existingId);
      }
    }

    // Apply update/create in incoming order so the response array order matches input.
    const result: unknown[] = [];
    for (const op of ops) {
      let childRow: unknown;
      let childId: number;
      if (op.kind === 'update') {
        childRow = await txnChildService.update(op.childId, op.data as any);
        childId = op.childId;
      } else {
        childRow = await txnChildService.create(op.data as any);
        childId = (childRow as { id: number }).id;
      }
      if (childRow === null) continue;
      const enriched = { ...(childRow as object) } as Record<string, unknown>;
      if (nested.length > 0) {
        const nestedReconciled = await this.processBindingsForParent(
          nested,
          childId,
          op.nestedFields,
          txn,
          mode,
        );
        Object.assign(enriched, nestedReconciled);
      }
      result.push(enriched);
    }

    return result;
  }

  private async loadExistingFor(
    binding: EagerWriteChildBinding,
    parentId: number,
    txn: IDatasource,
  ): Promise<unknown[]> {
    const nested = binding.children ?? [];

    if (isM2MBinding(binding)) {
      const linked = await this.m2mLoadLinked(binding, parentId, txn);
      if (nested.length === 0) return linked;
      const out: unknown[] = [];
      for (const target of linked) {
        const targetId = (target as { id: number }).id;
        const enriched = { ...(target as object) } as Record<string, unknown>;
        const nestedReconciled = await this.processBindingsForParent(
          nested,
          targetId,
          {},
          txn,
          'update',
        );
        Object.assign(enriched, nestedReconciled);
        out.push(enriched);
      }
      return out;
    }

    const txnChildRepo = binding.withTxnRepoFn(binding.repository, txn);
    const txnChildService = this.cloneService(binding.service, txnChildRepo);
    const existing = await txnChildService.findBy([
      { name: binding.fkColumn, value: String(parentId) },
    ]);
    if (nested.length === 0) return existing;
    const out: unknown[] = [];
    for (const child of existing) {
      const childId = (child as { id: number }).id;
      const enriched = { ...(child as object) } as Record<string, unknown>;
      const nestedReconciled = await this.processBindingsForParent(
        nested,
        childId,
        {},
        txn,
        'update',
      );
      Object.assign(enriched, nestedReconciled);
      out.push(enriched);
    }
    return out;
  }

  // Helpers

  private cloneService(
    service: IEntityService<any>,
    repo: ICrudRepository<any>,
  ): IEntityService<any> {
    return rebindServiceToTxn(service, repo);
  }

  private async m2mLoadLinked(
    binding: EagerWriteM2MBinding,
    parentId: number,
    txn: IDatasource,
  ): Promise<unknown[]> {
    const txnTargetService = this.cloneService(
      binding.service,
      binding.withTxnRepoFn(binding.repository, txn),
    );
    const txnJunctionRepo = binding.withTxnRepoFn(binding.junctionRepository, txn);
    const junctionRows = (await txnJunctionRepo.findBy(binding.parentFkColumn, parentId)) as Array<
      Record<string, unknown>
    >;
    const targetIds = junctionRows.map((j) => j[binding.targetFkColumn] as number);
    if (targetIds.length === 0) return [];
    const targets = await txnTargetService.findAll();
    const byId = new Map(targets.map((t) => [(t as { id: number }).id, t] as const));
    return targetIds.map((id) => byId.get(id)).filter((t) => t !== undefined);
  }

  private async resolveOrCreateTargetId(
    row: Record<string, unknown>,
    txnTargetService: IEntityService<any>,
  ): Promise<number> {
    const incomingId = row.id;
    if (typeof incomingId === 'number') {
      return incomingId;
    }
    const { id: _ignore, ...rest } = row;
    const created = await txnTargetService.create(rest as any);
    return (created as { id: number }).id;
  }

  private validateRowsRecursively(
    parentRow: Record<string, unknown>,
    bindings: EagerWriteChildBinding[],
    mode: Mode,
  ): void {
    for (const binding of bindings) {
      const rows = unpackEagerRelation(parentRow[binding.fieldName], relationIsArray(binding));
      if (rows === undefined) continue;
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        if (mode === 'create' && !isM2MBinding(binding) && 'id' in r) {
          throw new ValidationError(`nested row cannot have id field`);
        }
        if ((mode === 'update' || mode === 'patch') && 'id' in r && r.id === undefined) {
          throw new ValidationError(`id field cannot be null when provided`);
        }
        if (binding.children && binding.children.length > 0) {
          this.validateRowsRecursively(r, binding.children, mode);
        }
      }
    }
  }
}

// Module-private helpers

/**
 * Split an incoming row into:
 *   - `base`: row minus any keys that match a binding's `fieldName` (the columns
 *     to persist on the row's own table).
 *   - `nestedFields`: a partial row restricted to those bindings' fields, used
 *     for the next-level recursion.
 */
function splitRow(
  row: Record<string, unknown>,
  bindings: EagerWriteChildBinding[],
): { base: Record<string, unknown>; nestedFields: Record<string, unknown> } {
  const base: Record<string, unknown> = { ...row };
  const nestedFields: Record<string, unknown> = {};
  for (const b of bindings) {
    if (b.fieldName in base) {
      nestedFields[b.fieldName] = base[b.fieldName];
      delete base[b.fieldName];
    }
  }
  return { base, nestedFields };
}
