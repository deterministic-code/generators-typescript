import { Request, Response, NextFunction } from 'express';
import { IEntityService } from '../services/interfaces/IEntityService';
import { sendError } from '../responses/sendResponse';
import { extractParam, parsePositiveInt } from '../routes/routeParamUtils';

const MUTATION_METHODS = new Set(['PUT', 'PATCH', 'DELETE']);

export function protectBuiltinRow<T extends { is_builtin: boolean; name: string }>(
  service: IEntityService<T>,
  entityName: string,
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (!MUTATION_METHODS.has(req.method)) {
      next();
      return;
    }

    const id = parsePositiveInt(extractParam(req.params.id));
    if (id === null) {
      next();
      return;
    }

    try {
      const entity = await service.findById(id);
      if (!entity) {
        next();
        return;
      }

      if (!entity.is_builtin) {
        next();
        return;
      }

      if (req.method === 'DELETE') {
        sendError(_res, 403, 'FORBIDDEN', `Cannot delete ${entityName} because it's a builtin row`);
        return;
      }

      if (req.body && 'name' in req.body && req.body.name !== entity.name) {
        sendError(_res, 403, 'FORBIDDEN', `Cannot rename ${entityName} because it's a builtin row`);
        return;
      }

      if (req.body && 'is_builtin' in req.body) {
        delete req.body.is_builtin;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
