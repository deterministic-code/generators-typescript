import { Router, Request, Response, RequestHandler } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { IEntityService } from '../services/interfaces/IEntityService';
import { handleZodError } from '../errors/handleZodError';
import { handleBusinessError } from '../errors/handleBusinessError';
import { sendItem, sendItems, sendError } from '../responses/sendResponse';
import { idOr400, parseIdField } from './routeParamUtils';
import type { IdentityValue } from '../repositories/EntityIdentity';
import type { PrimaryKey } from '../repositories/PrimaryKey';

export interface NestedManyToManyConfig<_TParent = unknown, _TJunction = unknown> {
  parentService: IEntityService<any, any>;
  junctionService: IEntityService<any, any>;
  parentParamName: string;
  parentEntityName: string;
  childParamName: string;
  childEntityName: string;
  nestedPath: string;
  parentFkField: string;
  childFkField: string;
  bodyFields: string[];
  bodyFieldTypes?: Record<string, 'number' | 'string' | 'string_allow_empty' | 'boolean'>;
  childService?: IEntityService<any, any>;
  childCreateSchema?: z.ZodTypeAny;
  childParentFkField?: string;
  childPatchSchema?: z.ZodTypeAny;
  /** Combined-routes mount POST /:childId; default PUT. */
  linkVerb?: 'PUT' | 'POST';
}

type Cfg = NestedManyToManyConfig;
type Id = IdentityValue;
type Row = Record<string, unknown>;
type Ctx = Cfg & {
  bodySchema: z.ZodTypeAny;
  parentPrimaryKey: PrimaryKey;
  childPrimaryKey: PrimaryKey;
  junctionPrimaryKey: PrimaryKey;
};

const BODY_ZOD = {
  string: () => z.string().trim().min(1),
  string_allow_empty: () => z.string(),
  boolean: () => z.boolean(),
  number: () => z.number().int().positive(),
} as const;

const buildBodySchema = (config: Cfg, childPk: PrimaryKey) => {
  const shape: Record<string, ZodTypeAny> = {};
  for (const field of config.bodyFields) {
    const kind =
      config.bodyFieldTypes?.[field] ??
      (field === config.childFkField ? childPk.bodyFieldType() : 'number');
    shape[field] = (BODY_ZOD[kind] ?? BODY_ZOD.number)();
  }
  return z.object(shape);
};

const notFound = (res: Response, message: string): false => {
  sendError(res, 404, 'NOT_FOUND', message);
  return false;
};

const param = (pk: PrimaryKey, req: Request, name: string) =>
  parseIdField(pk.routeIdType, name, req.params[name]);

const requireParent = async (cfg: Ctx, parentId: Id, res: Response): Promise<boolean> =>
  (await cfg.parentService.findById(parentId))
    ? true
    : notFound(res, `${cfg.parentEntityName} with id '${parentId}' not found`);

const resolveParent = async (
  cfg: Ctx,
  req: Request,
  res: Response,
): Promise<{ parentId: Id } | null> => {
  const parentId = idOr400(res, param(cfg.parentPrimaryKey, req, cfg.parentParamName));
  if (parentId === null) return null;
  return (await requireParent(cfg, parentId, res)) ? { parentId } : null;
};

const resolvePair = async (
  cfg: Ctx,
  req: Request,
  res: Response,
): Promise<{ parentId: Id; childId: Id } | null> => {
  const parentId = idOr400(res, param(cfg.parentPrimaryKey, req, cfg.parentParamName));
  if (parentId === null) return null;
  const childId = idOr400(res, param(cfg.childPrimaryKey, req, cfg.childParamName));
  if (childId === null) return null;
  return (await requireParent(cfg, parentId, res)) ? { parentId, childId } : null;
};

const findMapping = async (
  cfg: Ctx,
  parentId: Id,
  childId: Id,
): Promise<Row | undefined> => {
  const all = (await cfg.junctionService.findAll()) as Row[];
  return all.find((j) => j[cfg.parentFkField] === parentId && j[cfg.childFkField] === childId);
};

const mappingGone = (cfg: Ctx, parentId: Id, childId: Id, res: Response) =>
  notFound(
    res,
    `${cfg.childEntityName} '${childId}' not found for ${cfg.parentEntityName} '${parentId}'`,
  );

const childGone = (cfg: Ctx, childId: Id, res: Response) =>
  notFound(res, `${cfg.childEntityName} with id '${childId}' not found`);

const requireMapping = async (cfg: Ctx, req: Request, res: Response) => {
  const pair = await resolvePair(cfg, req, res);
  if (!pair) return null;
  const mapping = await findMapping(cfg, pair.parentId, pair.childId);
  if (!mapping) {
    mappingGone(cfg, pair.parentId, pair.childId, res);
    return null;
  }
  return { ...pair, mapping };
};

const wrap =
  (
    fn: (req: Request, res: Response) => Promise<void>,
    onErr: (err: unknown, res: Response) => boolean = () => false,
  ): RequestHandler =>
  async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (onErr(err, res) || handleBusinessError(err, res)) return;
      next(err);
    }
  };

const zod = (err: unknown, res: Response) => handleZodError(err, res);

const junction = (cfg: Ctx, parentId: Id, extra: Row) =>
  cfg.junctionService.create({ [cfg.parentFkField]: parentId, ...extra } as never);

const list = (cfg: Ctx) =>
  wrap(async (req, res) => {
    const parent = await resolveParent(cfg, req, res);
    if (!parent) return;
    const rows = ((await cfg.junctionService.findAll()) as Row[]).filter(
      (j) => j[cfg.parentFkField] === parent.parentId,
    );
    if (!cfg.childService || rows.length === 0) {
      sendItems(res, rows);
      return;
    }
    const children = (await cfg.childService.findAll()) as Row[];
    const byId = new Map(children.map((c) => [cfg.childPrimaryKey.fromRow(c), c]));
    sendItems(res, rows.map((j) => byId.get(j[cfg.childFkField])).filter(Boolean));
  });

const post = (cfg: Ctx) =>
  wrap(async (req, res) => {
    const parent = await resolveParent(cfg, req, res);
    if (!parent) return;
    const { parentId } = parent;
    if (cfg.childCreateSchema && cfg.childService) {
      const data = { ...(cfg.childCreateSchema.parse(req.body) as Row) };
      if (cfg.childParentFkField) data[cfg.childParentFkField] = parentId;
      const child = await cfg.childService.create(data as never);
      await junction(cfg, parentId, {
        [cfg.childFkField]: cfg.childPrimaryKey.fromRow(child as Row),
      });
      sendItem(res, child as Row, 201);
      return;
    }
    const parsed = cfg.bodySchema.parse(req.body) as Row;
    const childId = parsed[cfg.childFkField] as Id | undefined;
    if (cfg.childService && childId !== undefined && !(await cfg.childService.findById(childId))) {
      childGone(cfg, childId, res);
      return;
    }
    const created = await junction(cfg, parentId, parsed);
    if (!cfg.childService) {
      sendItem(res, created as Row, 201);
      return;
    }
    const linked = (created as Row)[cfg.childFkField] as Id;
    sendItem(res, ((await cfg.childService.findById(linked)) ?? created) as Row, 201);
  }, zod);

const getOne = (cfg: Ctx) =>
  wrap(async (req, res) => {
    const found = await requireMapping(cfg, req, res);
    if (!found) return;
    const child = await cfg.childService!.findById(found.childId);
    if (!child) {
      childGone(cfg, found.childId, res);
      return;
    }
    sendItem(res, child as Row);
  });

const link = (cfg: Ctx, verb: 'PUT' | 'POST') =>
  wrap(async (req, res) => {
    const status = verb === 'POST' ? 201 : 200;
    const pair = await resolvePair(cfg, req, res);
    if (!pair) return;
    const child = await cfg.childService!.findById(pair.childId);
    if (!child) {
      childGone(cfg, pair.childId, res);
      return;
    }
    if (!(await findMapping(cfg, pair.parentId, pair.childId))) {
      await junction(cfg, pair.parentId, { [cfg.childFkField]: pair.childId });
    }
    if (cfg.childPatchSchema && req.body && Object.keys(req.body).length > 0) {
      const updated = await cfg.childService!.update(
        pair.childId,
        cfg.childPatchSchema.parse(req.body),
      );
      sendItem(res, (updated ?? child) as Row, status);
      return;
    }
    sendItem(res, child as Row, status);
  }, zod);

const patch = (cfg: Ctx) =>
  wrap(async (req, res) => {
    const found = await requireMapping(cfg, req, res);
    if (!found) return;
    const updated = await cfg.childService!.update(
      found.childId,
      cfg.childPatchSchema!.parse(req.body),
    );
    if (!updated) {
      childGone(cfg, found.childId, res);
      return;
    }
    sendItem(res, updated as Row);
  }, zod);

const remove = (cfg: Ctx) =>
  wrap(async (req, res) => {
    const found = await requireMapping(cfg, req, res);
    if (!found) return;
    await cfg.junctionService.delete(cfg.junctionPrimaryKey.fromRow(found.mapping) as Id);
    sendItem(res, { success: true });
  });

export const addNestedManyToManyRoutes = <TParent, TJunction>(
  router: Router,
  config: NestedManyToManyConfig<TParent, TJunction>,
): void => {
  const childPrimaryKey = config.childService?.primaryKey ?? config.junctionService.primaryKey;
  const cfg: Ctx = {
    ...config,
    parentPrimaryKey: config.parentService.primaryKey,
    childPrimaryKey,
    junctionPrimaryKey: config.junctionService.primaryKey,
    bodySchema: buildBodySchema(config, childPrimaryKey),
  };
  const collection = `/:${cfg.parentParamName}/${cfg.nestedPath}`;
  const member = `${collection}/:${cfg.childParamName}`;
  router.get(collection, list(cfg));
  router.post(collection, post(cfg));
  if (cfg.childService) {
    router.get(member, getOne(cfg));
    const verb = cfg.linkVerb ?? 'PUT';
    const register = verb === 'POST' ? router.post.bind(router) : router.put.bind(router);
    register(member, link(cfg, verb));
  }
  if (cfg.childPatchSchema && cfg.childService) router.patch(member, patch(cfg));
  router.delete(member, remove(cfg));
};
