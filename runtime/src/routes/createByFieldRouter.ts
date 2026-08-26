import { Router, Request, Response } from 'express';
import { ZodSchema } from 'zod';
import { IEntityService } from '../services/interfaces/IEntityService';
import { handleZodError } from '../errors/handleZodError';
import { sendItem, sendItems, sendError } from '../responses/sendResponse';
import { wrapRouteHandler as wrap } from './wrapRouteHandler';
import { snakeToKebab } from '../naming';

// Runtime twin of the `byFieldsBlock` emitter in scripts/lib/emit-routes-typescript.mjs, resolving routes.yaml `entity + byField` declarations without a hand-mounted emitted router.
export interface ByFieldRouterOptions<T> {
  service: IEntityService<T, number | string, Record<string, unknown>>;
  field: string;
  /** `true` = 1:1 resource (200/404, 409 on duplicates); `false` = collection (200 items[], DELETE returns { count }). */
  unique: boolean;
  methods: Array<'GET' | 'PUT' | 'DELETE'>;
  entityName: string;
  /** Optional update validation schema. When absent, PUT accepts the raw body. */
  updateSchema?: ZodSchema;
}

interface ByFieldContext<T> {
  service: IEntityService<T, number | string, Record<string, unknown>>;
  field: string;
  param: string;
  unique: boolean;
  entityName: string;
  updateSchema?: ZodSchema;
}

function paramName(field: string): string {
  // /:notification_type isn't valid Express; convert snake_case to camelCase.
  return field.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function valueFrom<T>(ctx: ByFieldContext<T>, req: Request): string {
  return req.params[ctx.param] ?? '';
}

/** For a unique byField, send 404 (no row) or 409 (multiple) and return true; return false when exactly one row matched so the caller proceeds. */
function sentUniqueMiss<T>(args: {
  ctx: ByFieldContext<T>;
  res: Response;
  matchCount: number;
  value: string;
}): boolean {
  const { ctx, res, matchCount, value } = args;
  if (matchCount === 0) {
    sendError(res, 404, 'NOT_FOUND', `${ctx.entityName} with ${ctx.field} '${value}' not found`);
    return true;
  }
  if (matchCount > 1) {
    sendError(
      res,
      409,
      'CONFLICT',
      `Multiple ${ctx.entityName} rows matched ${ctx.field}='${value}'`,
    );
    return true;
  }
  return false;
}

async function doGet<T>(
  ctx: ByFieldContext<T>,
  req: Request,
  res: Response,
): Promise<void> {
  const value = valueFrom(ctx, req);
  const rows = await ctx.service.findBy([{ name: ctx.field, value }]);
  if (!ctx.unique) {
    sendItems(res, rows as unknown as Record<string, unknown>[]);
    return;
  }
  if (sentUniqueMiss({ ctx, res, matchCount: rows.length, value })) return;
  sendItem(res, rows[0] as unknown as Record<string, unknown>);
}

async function doPut<T>(
  ctx: ByFieldContext<T>,
  req: Request,
  res: Response,
): Promise<void> {
  const value = valueFrom(ctx, req);
  const parsed = ctx.updateSchema ? ctx.updateSchema.parse(req.body) : req.body;
  const count = await ctx.service.updateBy(
    [{ name: ctx.field, value }],
    parsed as Record<string, unknown>,
  );
  if (!ctx.unique) {
    sendItem(res, { count });
    return;
  }
  if (sentUniqueMiss({ ctx, res, matchCount: count, value })) return;
  const rows = await ctx.service.findBy([{ name: ctx.field, value }]);
  sendItem(res, (rows[0] ?? null) as unknown as Record<string, unknown> | null);
}

async function doDelete<T>(
  ctx: ByFieldContext<T>,
  req: Request,
  res: Response,
): Promise<void> {
  const value = valueFrom(ctx, req);
  const count = await ctx.service.deleteBy([{ name: ctx.field, value }]);
  if (!ctx.unique) {
    sendItem(res, { count });
    return;
  }
  if (sentUniqueMiss({ ctx, res, matchCount: count, value })) return;
  res.status(204).end();
}

export function createByFieldRouter<T>(
  options: ByFieldRouterOptions<T>,
): Router {
  const router = Router();
  const { service, field, unique, methods, entityName, updateSchema } = options;
  const param = paramName(field);
  const ctx: ByFieldContext<T> = { service, field, param, unique, entityName, updateSchema };
  const path = `/${snakeToKebab(field)}/:${param}`;

  if (methods.includes('GET')) router.get(path, wrap([], (req, res) => doGet(ctx, req, res)));
  if (methods.includes('PUT')) {
    router.put(path, wrap([handleZodError], (req, res) => doPut(ctx, req, res)));
  }
  if (methods.includes('DELETE')) {
    router.delete(path, wrap([], (req, res) => doDelete(ctx, req, res)));
  }

  return router;
}
