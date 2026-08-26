import { Router, Request, Response, RequestHandler } from 'express';
import { z, ZodTypeAny } from 'zod';
import { IEntityService } from '../services/interfaces/IEntityService';
import { handleZodError } from '../errors/handleZodError';
import { handleBusinessError } from '../errors/handleBusinessError';
import { sendItem, sendItems, sendError } from '../responses/sendResponse';
import { idOr400, parseIdField } from './routeParamUtils';
import type { IdentityValue } from '../repositories/EntityIdentity';
import type { PrimaryKey } from '../repositories/PrimaryKey';

export interface NestedManyToManyConfig<_TParent, _TJunction> {
  /** The parent entity service (e.g., projectService) */
  parentService: IEntityService<any, any>;
  /** The junction entity service (e.g., projectSettingService) */
  junctionService: IEntityService<any, any>;
  /** The URL param name for the parent ID (e.g., "projectId") */
  parentParamName: string;
  /** The display name for the parent entity (e.g., "Project") */
  parentEntityName: string;
  /** The URL param name for the child ID in DELETE (e.g., "settingId") */
  childParamName: string;
  /** The display name for the child/junction entity (e.g., "Setting") */
  childEntityName: string;
  /** The nested path segment (e.g., "settings") */
  nestedPath: string;
  /** The field on the junction entity that references the parent (e.g., "project_id") */
  parentFkField: string;
  /** The field on the junction entity used to match the child param in DELETE (e.g., "permission_id" or "id") */
  childFkField: string;
  /** The body fields required in POST (e.g., ["permission_id"] or ["name", "value"]) */
  bodyFields: Array<string>;
  /** Optional: override the Zod type for body fields. Default is positive int.
   *  "string" = z.string().trim().min(1) (non-empty)
   *  "string_allow_empty" = z.string() (any string, including empty)
   *  "boolean" = z.boolean()
   */
  bodyFieldTypes?: Record<string, 'number' | 'string' | 'string_allow_empty' | 'boolean'>;
  /** Optional: the child entity service for pure M2M routes.
   *  When provided, GET returns resolved child entities instead of junction records,
   *  and POST returns the resolved child entity instead of the junction record.
   */
  childService?: IEntityService<any, any>;
  /** Optional: Zod schema for creating a new child entity.
   *  When provided along with childService, POST uses create-and-link mode:
   *  validates body against this schema, creates child via childService.add(),
   *  creates junction linking parent to new child, returns the child.
   */
  childCreateSchema?: z.ZodTypeAny;
  /** Optional: when the child entity has a FK referencing the parent,
   *  this field name will be injected with the parent ID into the child create data.
   *  Example: Token has user_id, so childParentFkField = "user_id".
   */
  childParentFkField?: string;
  /** Optional: Zod schema for PATCH on the child entity.
   *  When provided along with childService, a PATCH route is registered:
   *  PATCH /:parentId/<nestedPath>/:childId
   *  Validates body, verifies parent-child link exists, calls childService.update().
   */
  childPatchSchema?: z.ZodTypeAny;
  /** Optional: HTTP verb for the link-existing-child route. Default "PUT".
   *  When set to "POST", the link route is mounted as POST /:parentId/<nestedPath>/:childId
   *  with the same idempotent semantics. Used by combined_routes auto-mount to preserve
   *  the existing wire contract where m2m children are linked via POST /:childId.
   */
  linkVerb?: 'PUT' | 'POST';
}

type M2mConfig = NestedManyToManyConfig<any, any>;
type IdValue = IdentityValue;
type JunctionRow = Record<string, unknown>;
/** Resolved config passed to every handler/helper: the caller's config plus the POST body schema and the primary keys read off the parent/child/junction services, so no helper re-threads them. */
type M2mCtx = M2mConfig & {
  bodySchema: z.ZodTypeAny;
  parentPrimaryKey: PrimaryKey;
  childPrimaryKey: PrimaryKey;
  junctionPrimaryKey: PrimaryKey;
};
type ParentCtx = { parentId: IdentityValue };
type ChildCtx = { parentId: IdentityValue; childId: IdentityValue };

/**
 * Builds a Zod schema for the POST body based on the configured body fields.
 * By default, fields are z.number().int().positive().
 * Fields listed in bodyFieldTypes with "string" use z.string().trim().min(1).
 * Fields listed with "string_allow_empty" use z.string() (allows empty strings).
 * Fields listed with "boolean" use z.boolean().
 */
function buildBodySchema(
  config: M2mConfig,
  childPrimaryKey: PrimaryKey,
): z.ZodObject<Record<string, ZodTypeAny>> {
  const shape: Record<string, ZodTypeAny> = {};
  for (const field of config.bodyFields) {
    // The child FK field references the child's PK, so default it to that key's body type (string for uuid/string keys) instead of assuming a number.
    const fieldType =
      config.bodyFieldTypes?.[field] ??
      (field === config.childFkField ? childPrimaryKey.bodyFieldType() : undefined);
    if (fieldType === 'string') {
      shape[field] = z.string().trim().min(1);
    } else if (fieldType === 'string_allow_empty') {
      shape[field] = z.string();
    } else if (fieldType === 'boolean') {
      shape[field] = z.boolean();
    } else {
      shape[field] = z.number().int().positive();
    }
  }
  return z.object(shape);
}

async function requireParent(cfg: M2mCtx, parentId: IdentityValue, res: Response): Promise<boolean> {
  if (await cfg.parentService.findById(parentId)) return true;
  sendError(res, 404, 'NOT_FOUND', `${cfg.parentEntityName} with id '${parentId}' not found`);
  return false;
}

/** Parse `/:parentId` and confirm the parent row exists; sends the 400/404 and returns null on failure. */
function parseParamWith(pk: PrimaryKey, req: Request, paramName: string) {
  return parseIdField(pk.routeIdType, paramName, req.params[paramName]);
}

async function resolveParent(cfg: M2mCtx, req: Request, res: Response): Promise<ParentCtx | null> {
  const parentId = idOr400(res, parseParamWith(cfg.parentPrimaryKey, req, cfg.parentParamName));
  if (parentId === null) return null;
  return (await requireParent(cfg, parentId, res)) ? { parentId } : null;
}

/** Parse `/:parentId` + `/:childId` (parent first) and confirm the parent exists; sends the 400/404 and returns null on failure. */
async function resolveParentAndChild(
  cfg: M2mCtx,
  req: Request,
  res: Response,
): Promise<ChildCtx | null> {
  const parentId = idOr400(res, parseParamWith(cfg.parentPrimaryKey, req, cfg.parentParamName));
  if (parentId === null) return null;
  const childId = idOr400(res, parseParamWith(cfg.childPrimaryKey, req, cfg.childParamName));
  if (childId === null) return null;
  return (await requireParent(cfg, parentId, res)) ? { parentId, childId } : null;
}

async function findMapping(cfg: M2mCtx, ctx: ChildCtx): Promise<JunctionRow | undefined> {
  const all = await cfg.junctionService.findAll();
  return (all as JunctionRow[]).find(
    (j) => j[cfg.parentFkField] === ctx.parentId && j[cfg.childFkField] === ctx.childId,
  );
}

function sendMappingNotFound(cfg: M2mCtx, ctx: ChildCtx, res: Response): void {
  sendError(
    res,
    404,
    'NOT_FOUND',
    `${cfg.childEntityName} '${ctx.childId}' not found for ${cfg.parentEntityName} '${ctx.parentId}'`,
  );
}

function sendChildNotFound(cfg: M2mCtx, childId: IdValue, res: Response): void {
  sendError(res, 404, 'NOT_FOUND', `${cfg.childEntityName} with id '${childId}' not found`);
}

/** Resolve `/:parentId/:childId` and the junction row linking them; sends the 400/404 and returns null on any failure. */
async function requireMapping(
  cfg: M2mCtx,
  req: Request,
  res: Response,
): Promise<{ ctx: ChildCtx; mapping: JunctionRow } | null> {
  const ctx = await resolveParentAndChild(cfg, req, res);
  if (!ctx) return null;
  const mapping = await findMapping(cfg, ctx);
  if (!mapping) {
    sendMappingNotFound(cfg, ctx, res);
    return null;
  }
  return { ctx, mapping };
}

function wrap(
  fn: (req: Request, res: Response) => Promise<void>,
  handledError: (err: unknown, res: Response) => boolean,
): RequestHandler {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (handledError(err, res)) return;
      if (handleBusinessError(err, res)) return;
      next(err);
    }
  };
}

const rethrow = (): boolean => false;
const zodOnly = (err: unknown, res: Response): boolean => handleZodError(err, res);

function makeListHandler(cfg: M2mCtx): RequestHandler {
  return wrap(async (req, res) => {
    const ctx = await resolveParent(cfg, req, res);
    if (!ctx) return;
    const allJunctions = await cfg.junctionService.findAll();
    const filtered = (allJunctions as Record<string, unknown>[]).filter(
      (j) => j[cfg.parentFkField] === ctx.parentId,
    );
    if (cfg.childService && filtered.length > 0) {
      const allChildren = (await cfg.childService.findAll()) as Record<string, unknown>[];
      const childMap = new Map(allChildren.map((c) => [cfg.childPrimaryKey.valueOf(c), c]));
      const resolved = filtered
        .map((j) => childMap.get(j[cfg.childFkField]))
        .filter((c): c is Record<string, unknown> => c != null);
      sendItems(res, resolved as unknown[]);
    } else {
      sendItems(res, filtered as unknown[]);
    }
  }, rethrow);
}

type PostArgs = { parentId: IdValue; body: unknown };

async function createAndLinkChild(cfg: M2mCtx, res: Response, args: PostArgs): Promise<void> {
  const parsed = cfg.childCreateSchema!.parse(args.body);
  const childCreateData = { ...(parsed as Record<string, unknown>) };
  if (cfg.childParentFkField) childCreateData[cfg.childParentFkField] = args.parentId;
  const child = await cfg.childService!.create(childCreateData as unknown as any);
  const childId = cfg.childPrimaryKey.valueOf(child as Record<string, unknown>) as IdValue;
  await cfg.junctionService.create({
    [cfg.parentFkField]: args.parentId,
    [cfg.childFkField]: childId,
  } as unknown as any);
  sendItem(res, child as Record<string, unknown>, 201);
}

async function linkExistingChild(cfg: M2mCtx, res: Response, args: PostArgs): Promise<void> {
  const parsed = cfg.bodySchema.parse(args.body) as Record<string, unknown>;
  if (cfg.childService) {
    const childId = parsed[cfg.childFkField] as IdValue | undefined;
    if (childId !== undefined && !(await cfg.childService.findById(childId))) {
      sendChildNotFound(cfg, childId, res);
      return;
    }
  }
  const created = await cfg.junctionService.create({
    [cfg.parentFkField]: args.parentId,
    ...parsed,
  } as unknown as any);
  if (cfg.childService) {
    const childId = (created as Record<string, unknown>)[cfg.childFkField] as IdValue;
    const child = await cfg.childService.findById(childId);
    sendItem(res, (child ?? created) as Record<string, unknown>, 201);
  } else {
    sendItem(res, created as Record<string, unknown>, 201);
  }
}

function makePostHandler(cfg: M2mCtx): RequestHandler {
  return wrap(async (req, res) => {
    const ctx = await resolveParent(cfg, req, res);
    if (!ctx) return;
    const args: PostArgs = { parentId: ctx.parentId, body: req.body };
    if (cfg.childCreateSchema && cfg.childService) {
      await createAndLinkChild(cfg, res, args);
    } else {
      await linkExistingChild(cfg, res, args);
    }
  }, zodOnly);
}

function makeGetByIdHandler(cfg: M2mCtx): RequestHandler {
  return wrap(async (req, res) => {
    const found = await requireMapping(cfg, req, res);
    if (!found) return;
    const child = await cfg.childService!.findById(found.ctx.childId);
    if (!child) {
      sendChildNotFound(cfg, found.ctx.childId, res);
      return;
    }
    sendItem(res, child as Record<string, unknown>);
  }, rethrow);
}

function makeLinkHandler(cfg: M2mCtx, linkVerb: 'PUT' | 'POST'): RequestHandler {
  const linkStatus = linkVerb === 'POST' ? 201 : 200;
  return wrap(async (req, res) => {
    const ctx = await resolveParentAndChild(cfg, req, res);
    if (!ctx) return;
    const child = await cfg.childService!.findById(ctx.childId);
    if (!child) {
      sendChildNotFound(cfg, ctx.childId, res);
      return;
    }
    if (!(await findMapping(cfg, ctx))) {
      await cfg.junctionService.create({
        [cfg.parentFkField]: ctx.parentId,
        [cfg.childFkField]: ctx.childId,
      } as unknown as any);
    }
    if (cfg.childPatchSchema && req.body && Object.keys(req.body).length > 0) {
      const parsed = cfg.childPatchSchema.parse(req.body);
      const updated = await cfg.childService!.update(ctx.childId, parsed);
      sendItem(res, (updated ?? child) as Record<string, unknown>, linkStatus);
      return;
    }
    sendItem(res, child as Record<string, unknown>, linkStatus);
  }, zodOnly);
}

function makePatchHandler(cfg: M2mCtx): RequestHandler {
  return wrap(async (req, res) => {
    const found = await requireMapping(cfg, req, res);
    if (!found) return;
    const parsed = cfg.childPatchSchema!.parse(req.body);
    const updated = await cfg.childService!.update(found.ctx.childId, parsed);
    if (!updated) {
      sendChildNotFound(cfg, found.ctx.childId, res);
      return;
    }
    sendItem(res, updated as Record<string, unknown>);
  }, zodOnly);
}

function makeDeleteHandler(cfg: M2mCtx): RequestHandler {
  return wrap(async (req, res) => {
    const found = await requireMapping(cfg, req, res);
    if (!found) return;
    await cfg.junctionService.delete(cfg.junctionPrimaryKey.valueOf(found.mapping) as IdValue);
    sendItem(res, { success: true });
  }, rethrow);
}

/**
 * Adds nested many-to-many GET/POST/DELETE routes to an existing router.
 *
 * GET  /:parentId/<nestedPath>             - List junction records filtered by parent FK
 * POST /:parentId/<nestedPath>             - Create a junction record (parent FK from URL, body fields from request)
 * DELETE /:parentId/<nestedPath>/:childId  - Delete a junction record by finding the mapping
 */
export function addNestedManyToManyRoutes<TParent, TJunction>(
  router: Router,
  config: NestedManyToManyConfig<TParent, TJunction>,
): void {
  const childPrimaryKey = config.childService?.primaryKey ?? config.junctionService.primaryKey;
  const cfg: M2mCtx = {
    ...(config as M2mConfig),
    parentPrimaryKey: config.parentService.primaryKey,
    childPrimaryKey,
    junctionPrimaryKey: config.junctionService.primaryKey,
    bodySchema: buildBodySchema(config, childPrimaryKey),
  };
  const getPath = `/:${cfg.parentParamName}/${cfg.nestedPath}`;
  const childPath = `/:${cfg.parentParamName}/${cfg.nestedPath}/:${cfg.childParamName}`;

  router.get(getPath, makeListHandler(cfg));
  router.post(getPath, makePostHandler(cfg));

  if (cfg.childService) {
    router.get(childPath, makeGetByIdHandler(cfg));
    const linkVerb = cfg.linkVerb ?? 'PUT';
    const linkRegister = linkVerb === 'POST' ? router.post.bind(router) : router.put.bind(router);
    linkRegister(childPath, makeLinkHandler(cfg, linkVerb));
  }

  if (cfg.childPatchSchema && cfg.childService) {
    router.patch(childPath, makePatchHandler(cfg));
  }

  router.delete(childPath, makeDeleteHandler(cfg));
}
