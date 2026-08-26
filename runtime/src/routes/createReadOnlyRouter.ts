import { Router, Request, Response, NextFunction } from 'express';
import { IEntityService } from '../services/interfaces/IEntityService';
import { sendItem, sendItems, sendError } from '../responses/sendResponse';
import { idOr400, parseIdField } from './routeParamUtils';
import { handleBusinessError } from '../errors/handleBusinessError';

export interface ReadOnlyRouterOptions<T, TId = number | string> {
  service: IEntityService<T, TId>;
  entityName: string;
  enrichItems?: (items: T[]) => Promise<T[]>;
  enrichItem?: (item: T) => Promise<T>;
}

export function createReadOnlyRouter<T, TId = number | string>(
  options: ReadOnlyRouterOptions<T, TId>,
): Router {
  const { service, entityName, enrichItems, enrichItem } = options;
  const primaryKey = service.primaryKey;
  const router = Router();

  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await service.findAll();
      const out = enrichItems ? await enrichItems(items) : items;
      sendItems(res, out as unknown[]);
    } catch (err) {
      if (handleBusinessError(err, res)) return;
      next(err);
    }
  });

  router.get(primaryKey.routeSegment(), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = idOr400(
        res,
        parseIdField(primaryKey.routeIdType, primaryKey.column, req.params[primaryKey.column]),
      );
      if (id === null) return;

      const item = await service.findById(id as Parameters<typeof service.findById>[0]);
      if (!item) {
        sendError(res, 404, 'NOT_FOUND', `${entityName} with id '${id}' not found`);
        return;
      }

      const out = enrichItem ? await enrichItem(item) : item;
      sendItem(res, out as Record<string, unknown>);
    } catch (err) {
      if (handleBusinessError(err, res)) return;
      next(err);
    }
  });

  return router;
}
