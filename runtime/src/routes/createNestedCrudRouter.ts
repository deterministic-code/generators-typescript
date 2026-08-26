import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodSchema } from 'zod';
import { IEntityService } from '../services/interfaces/IEntityService';
import { handleZodError } from '../errors/handleZodError';
import { handleConstraintError } from '../errors/handleConstraintError';
import { handleBusinessError } from '../errors/handleBusinessError';
import { sendItem, sendItems, sendError } from '../responses/sendResponse';
import { idOr400, parseIdField } from './routeParamUtils';
import type { PrimaryKey } from '../repositories/PrimaryKey';

export interface NestedCrudRouterOptions<T> {
  service: IEntityService<any, any>;
  createSchema: ZodSchema;
  updateSchema: ZodSchema;
  patchSchema?: ZodSchema;
  parentParamName: string;
  parentFkField: keyof T & string;
  parentEntityName: string;
  entityName: string;
  /** The parent entity's primary key — parses the `/:<parentParamName>` segment. The child's key is read from `service.primaryKey`. */
  parentPrimaryKey: PrimaryKey;
  mutationMiddleware?: RequestHandler[];
}

interface NestedCtx<T> {
  service: IEntityService<any, any>;
  createSchema: ZodSchema;
  updateSchema: ZodSchema;
  patchSchema: ZodSchema;
  parentParamName: string;
  parentFkField: keyof T & string;
  entityName: string;
  parentPrimaryKey: PrimaryKey;
  childPrimaryKey: PrimaryKey;
}

function parseParentId<T>(cfg: NestedCtx<T>, req: Request, res: Response): number | string | null {
  const pk = cfg.parentPrimaryKey;
  return idOr400(
    res,
    parseIdField(pk.routeIdType, cfg.parentParamName, req.params[cfg.parentParamName]),
  );
}

function parseChildId<T>(cfg: NestedCtx<T>, req: Request, res: Response): number | string | null {
  const pk = cfg.childPrimaryKey;
  return idOr400(res, parseIdField(pk.routeIdType, pk.column, req.params[pk.column]));
}

function notFound<T>(cfg: NestedCtx<T>, res: Response, childId: number | string): void {
  sendError(res, 404, 'NOT_FOUND', `${cfg.entityName} with id '${childId}' not found`);
}

/** The child row addressed by `/:id` iff it exists AND belongs to `ids.parentId`; sends the 404 and returns null otherwise. */
async function findOwnedChild<T>(
  cfg: NestedCtx<T>,
  ids: { parentId: number | string; childId: number | string },
  res: Response,
): Promise<Record<string, unknown> | null> {
  const allItems = await cfg.service.findAll();
  const item = allItems.find((i) =>
    cfg.childPrimaryKey.matches(i as Record<string, unknown>, ids.childId),
  ) as Record<string, unknown> | undefined;
  if (!item || item[cfg.parentFkField] !== ids.parentId) {
    notFound(cfg, res, ids.childId);
    return null;
  }
  return item;
}

function withParent<T>(
  cfg: NestedCtx<T>,
  body: unknown,
  parentId: number | string,
): Record<string, unknown> {
  return { ...((body ?? {}) as Record<string, unknown>), [cfg.parentFkField]: parentId };
}

interface OwnedChild {
  parentId: number | string;
  childId: number | string;
  item: Record<string, unknown>;
}

/** Parse `/:parentId` + `/:id` and load the child row iff it belongs to the parent; sends the 400/404 and returns null on any failure. */
async function resolveChild<T>(
  cfg: NestedCtx<T>,
  req: Request,
  res: Response,
): Promise<OwnedChild | null> {
  const parentId = parseParentId(cfg, req, res);
  if (parentId === null) return null;
  const childId = parseChildId(cfg, req, res);
  if (childId === null) return null;
  const item = await findOwnedChild(cfg, { parentId, childId }, res);
  return item ? { parentId, childId, item } : null;
}

function wrapHandler(
  fn: (req: Request, res: Response) => Promise<void>,
  onError: (err: unknown, res: Response) => boolean,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (onError(err, res)) return;
      if (handleBusinessError(err, res)) return;
      next(err);
    }
  };
}

const rethrow = (): boolean => false;
const mutationErrors = (err: unknown, res: Response): boolean =>
  handleZodError(err, res) || handleConstraintError(err, res);

function makeListHandler<T>(cfg: NestedCtx<T>) {
  return wrapHandler(async (req, res) => {
    const parentId = parseParentId(cfg, req, res);
    if (parentId === null) return;
    const allItems = await cfg.service.findAll();
    const filtered = allItems.filter(
      (item) => (item as Record<string, unknown>)[cfg.parentFkField] === parentId,
    );
    sendItems(res, filtered as unknown[]);
  }, rethrow);
}

function makeGetHandler<T>(cfg: NestedCtx<T>) {
  return wrapHandler(async (req, res) => {
    const owned = await resolveChild(cfg, req, res);
    if (owned) sendItem(res, owned.item);
  }, rethrow);
}

function makeCreateHandler<T>(cfg: NestedCtx<T>) {
  return wrapHandler(async (req, res) => {
    const parentId = parseParentId(cfg, req, res);
    if (parentId === null) return;
    const parsed = cfg.createSchema.parse(withParent(cfg, req.body, parentId));
    const createData = {
      ...(parsed as Record<string, unknown>),
      [cfg.parentFkField]: parentId,
    } as Omit<T, 'id'>;
    const item = await cfg.service.create(createData);
    sendItem(res, item as Record<string, unknown>, 201);
  }, mutationErrors);
}

function makeUpdateHandler<T>(cfg: NestedCtx<T>, schema: ZodSchema) {
  return wrapHandler(async (req, res) => {
    const owned = await resolveChild(cfg, req, res);
    if (!owned) return;
    const parsed = schema.parse(withParent(cfg, req.body, owned.parentId));
    const pinnedToParent = {
      ...(parsed as Record<string, unknown>),
      [cfg.parentFkField]: owned.parentId,
    };
    const updated = await cfg.service.update(
      owned.childId,
      pinnedToParent as Partial<Omit<T, 'id'>>,
    );
    if (!updated) return notFound(cfg, res, owned.childId);
    sendItem(res, updated as Record<string, unknown>);
  }, mutationErrors);
}

function makeDeleteHandler<T>(cfg: NestedCtx<T>) {
  return wrapHandler(async (req, res) => {
    const owned = await resolveChild(cfg, req, res);
    if (!owned) return;
    const deleted = await cfg.service.delete(owned.childId);
    if (!deleted) return notFound(cfg, res, owned.childId);
    sendItem(res, { success: true });
  }, handleConstraintError);
}

export function createNestedCrudRouter<T>(options: NestedCrudRouterOptions<T>): Router {
  const cfg: NestedCtx<T> = {
    service: options.service,
    createSchema: options.createSchema,
    updateSchema: options.updateSchema,
    patchSchema: options.patchSchema ?? options.updateSchema,
    parentParamName: options.parentParamName,
    parentFkField: options.parentFkField,
    entityName: options.entityName,
    parentPrimaryKey: options.parentPrimaryKey,
    childPrimaryKey: options.service.primaryKey,
  };
  const mutationMiddleware = options.mutationMiddleware ?? [];
  const member = cfg.childPrimaryKey.routeSegment();
  const router = Router({ mergeParams: true });

  router.get('/', makeListHandler(cfg));
  router.get(member, makeGetHandler(cfg));
  router.post('/', makeCreateHandler(cfg));
  router.put(member, ...mutationMiddleware, makeUpdateHandler(cfg, cfg.updateSchema));
  router.patch(member, ...mutationMiddleware, makeUpdateHandler(cfg, cfg.patchSchema));
  router.delete(member, ...mutationMiddleware, makeDeleteHandler(cfg));

  return router;
}
