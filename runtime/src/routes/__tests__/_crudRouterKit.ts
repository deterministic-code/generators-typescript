import express from 'express';
import { z } from 'zod';
import { vi } from 'vitest';
import { createCrudRouter } from '../createCrudRouter';
import { errorHandler } from '../../middleware/errorHandler';
import { PrimaryKey } from '../../repositories/PrimaryKey';
import type {
  IEntityService,
} from '../../services/interfaces/IEntityService';

export interface Item {
  id: number;
  uuid: string;
  name: string;
  created: string;
  updated: string;
}

export const sampleItem: Item = { id: 1, uuid: 'u1', name: 'a', created: 't', updated: 't' };

export interface ItemCrudAppOptions {
  patchSchema?: z.ZodSchema;
  enrichItem?: (item: Item) => Promise<Item>;
  /** Append the production global errorHandler middleware. */
  withErrorHandler?: boolean;
  /** Append a trailing error middleware that records the error and answers 599 — proves whether next(err) was reached. */
  captureNext?: (err: unknown) => void;
}

/** Mount `createCrudRouter` for {@link Item} on a bare express app at `/items`, sharing the schema + wiring boilerplate across the crud-router suites. */
export function buildItemCrudApp(
  service: jest.Mocked<IEntityService<Item>>,
  options: ItemCrudAppOptions = {},
): express.Express {
  const schema = z.object({ name: z.string() });
  const router = createCrudRouter<Item>({
    service,
    createSchema: schema,
    updateSchema: schema,
    patchSchema: options.patchSchema,
    entityName: 'Item',
    enrichItem: options.enrichItem,
  });
  const app = express();
  app.use(express.json());
  app.use('/items', router);
  if (options.withErrorHandler) app.use(errorHandler);
  if (options.captureNext || !options.withErrorHandler) {
    const trailing: express.ErrorRequestHandler = (err, _req, res, _next) => {
      options.captureNext?.(err);
      res.status(599).json({ reachedNext: true });
    };
    app.use(trailing);
  }
  return app;
}

/** A fully mocked integer-`id` service typed to {@link Item}, the default service the `Item` crud-router suites drive. */
export const createItemService = (): jest.Mocked<IEntityService<Item>> =>
  createMockCrudService<Item>();

/** A fully mocked {@link IEntityService} for the crud-router integration suites; `primaryKey` defaults to the integer `id` key. */
export function createMockCrudService<T>(
  primaryKey: PrimaryKey = new PrimaryKey('id', 'integer'),
): jest.Mocked<IEntityService<T>> {
  return {
    primaryKey,
    query: vi.fn(),
    findAll: vi.fn(),
    create: vi.fn(),
    find: vi.fn(),
    findById: vi.fn(),
    findBy: vi.fn(),
    update: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    updateBy: vi.fn(),
    deleteBy: vi.fn(),
  };
}
