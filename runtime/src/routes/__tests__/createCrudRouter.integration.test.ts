import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { createCrudRouter } from '../createCrudRouter';
import { PrimaryKey } from '../../repositories/PrimaryKey';
import { errorHandler } from '../../middleware/errorHandler';
import type { IEntityService } from '../../services/interfaces/IEntityService';
import { type Item, createItemService as createService, createMockCrudService } from './_crudRouterKit';

function buildApp(
  service: jest.Mocked<IEntityService<Item>>,
  overrides: Partial<{
    patchSchema: z.ZodSchema;
    mutationMiddleware: express.RequestHandler[];
    resolveItem: (item: Item) => Promise<Item>;
  }> = {},
) {
  const createSchema = z.object({ name: z.string() });
  const updateSchema = z.object({ name: z.string() });
  const router = createCrudRouter<Item>({
    service,
    createSchema,
    updateSchema,
    patchSchema: overrides.patchSchema,
    mutationMiddleware: overrides.mutationMiddleware,
    resolveItem: overrides.resolveItem,
    entityName: 'Item',
  });
  const app = express();
  app.use(express.json());
  app.use('/items', router);
  app.use(errorHandler);
  return app;
}

const sample: Item = {
  id: 1,
  uuid: 'u1',
  name: 'a',
  created: 't',
  updated: 't',
};

describe('createCrudRouter', () => {
  it('GET / returns items wrapped under items', async () => {
    const service = createService();
    service.findAll.mockResolvedValue([sample]);
    const res = await request(buildApp(service)).get('/items');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [sample] });
  });

  it('GET / forwards errors to next()', async () => {
    const service = createService();
    service.findAll.mockRejectedValue(new Error('boom'));
    const suppress = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(buildApp(service)).get('/items');
    expect(res.status).toBe(500);
    suppress.mockRestore();
  });

  it('GET /:id returns 400 for bad id', async () => {
    const service = createService();
    const res = await request(buildApp(service)).get('/items/0');
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('GET /:id returns 404 when not found', async () => {
    const service = createService();
    service.findById.mockResolvedValue(null);
    const res = await request(buildApp(service)).get('/items/7');
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('GET /:id returns the item', async () => {
    const service = createService();
    service.findById.mockResolvedValue(sample);
    const res = await request(buildApp(service)).get('/items/1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(sample);
  });

  it('GET /:id forwards unexpected errors to next()', async () => {
    const service = createService();
    service.findById.mockRejectedValue(new Error('boom'));
    const suppress = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(buildApp(service)).get('/items/1');
    expect(res.status).toBe(500);
    suppress.mockRestore();
  });

  it('POST / returns 400 for invalid body', async () => {
    const service = createService();
    const res = await request(buildApp(service)).post('/items').send({ name: 42 });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('POST / returns the created item at 201', async () => {
    const service = createService();
    service.create.mockResolvedValue(sample);
    const res = await request(buildApp(service)).post('/items').send({ name: 'a' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(sample);
  });

  it('POST / forwards non-zod errors to next()', async () => {
    const service = createService();
    service.create.mockRejectedValue(new Error('boom'));
    const suppress = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(buildApp(service)).post('/items').send({ name: 'a' });
    expect(res.status).toBe(500);
    suppress.mockRestore();
  });

  it('PUT /:id validates id', async () => {
    const service = createService();
    const res = await request(buildApp(service)).put('/items/-1').send({ name: 'a' });
    expect(res.status).toBe(400);
  });

  it('PUT /:id returns 404 when update returns null', async () => {
    const service = createService();
    service.update.mockResolvedValue(null);
    const res = await request(buildApp(service)).put('/items/1').send({ name: 'a' });
    expect(res.status).toBe(404);
  });

  it('PUT /:id returns the updated item', async () => {
    const service = createService();
    service.update.mockResolvedValue(sample);
    const res = await request(buildApp(service)).put('/items/1').send({ name: 'a' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(sample);
  });

  it('PUT /:id returns 400 for invalid body', async () => {
    const service = createService();
    const res = await request(buildApp(service)).put('/items/1').send({ name: 42 });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('PUT /:id forwards non-zod errors to next()', async () => {
    const service = createService();
    service.update.mockRejectedValue(new Error('boom'));
    const suppress = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(buildApp(service)).put('/items/1').send({ name: 'a' });
    expect(res.status).toBe(500);
    suppress.mockRestore();
  });

  it('PATCH /:id uses patchSchema when provided', async () => {
    const service = createService();
    service.patch.mockResolvedValue(sample);
    const patchSchema = z.object({ name: z.string().optional() });
    const app = buildApp(service, { patchSchema });
    const res = await request(app).patch('/items/1').send({});
    expect(res.status).toBe(200);
  });

  it('PATCH /:id defaults to updateSchema when patchSchema not provided', async () => {
    const service = createService();
    service.patch.mockResolvedValue(sample);
    const res = await request(buildApp(service)).patch('/items/1').send({ name: 'b' });
    expect(res.status).toBe(200);
  });

  it('DELETE /:id validates id', async () => {
    const service = createService();
    const res = await request(buildApp(service)).delete('/items/abc');
    expect(res.status).toBe(400);
  });

  it('DELETE /:id returns 404 when service returns false', async () => {
    const service = createService();
    service.delete.mockResolvedValue(false);
    const res = await request(buildApp(service)).delete('/items/1');
    expect(res.status).toBe(404);
  });

  it('DELETE /:id returns success envelope', async () => {
    const service = createService();
    service.delete.mockResolvedValue(true);
    const res = await request(buildApp(service)).delete('/items/1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('DELETE /:id forwards unexpected errors to next()', async () => {
    const service = createService();
    service.delete.mockRejectedValue(new Error('boom'));
    const suppress = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(buildApp(service)).delete('/items/1');
    expect(res.status).toBe(500);
    suppress.mockRestore();
  });

  it('POST / runs resolveItem before service.add', async () => {
    const service = createService();
    service.create.mockResolvedValue(sample);
    const resolveItem = vi.fn(
      async (item: Item) => ({ ...item, name: `resolved-${item.name}` }) as Item,
    );
    const app = buildApp(service, { resolveItem });
    const res = await request(app).post('/items').send({ name: 'a' });
    expect(res.status).toBe(201);
    expect(resolveItem).toHaveBeenCalledWith({ name: 'a' });
    expect(service.create).toHaveBeenCalledWith({ name: 'resolved-a' });
  });

  it('PUT /:id runs resolveItem before service.update', async () => {
    const service = createService();
    service.update.mockResolvedValue(sample);
    const resolveItem = vi.fn(
      async (item: Item) => ({ ...item, name: `resolved-${item.name}` }) as Item,
    );
    const app = buildApp(service, { resolveItem });
    await request(app).put('/items/1').send({ name: 'b' });
    expect(resolveItem).toHaveBeenCalledWith({ name: 'b' });
    expect(service.update).toHaveBeenCalledWith(1, { name: 'resolved-b' });
  });

  it('PATCH /:id runs resolveItem before service.patch', async () => {
    const service = createService();
    service.patch.mockResolvedValue(sample);
    const resolveItem = vi.fn(
      async (item: Item) => ({ ...item, name: `resolved-${item.name}` }) as Item,
    );
    const app = buildApp(service, { resolveItem });
    await request(app).patch('/items/1').send({ name: 'c' });
    expect(resolveItem).toHaveBeenCalledWith({ name: 'c' });
    expect(service.patch).toHaveBeenCalledWith(1, { name: 'resolved-c' });
  });

  it('POST / returns 500 and skips service.add when resolveItem throws', async () => {
    const service = createService();
    const resolveItem = vi.fn(async () => {
      throw new Error('no such name');
    });
    const suppress = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = buildApp(service, { resolveItem });
    const res = await request(app).post('/items').send({ name: 'a' });
    expect(res.status).toBe(500);
    expect(service.create).not.toHaveBeenCalled();
    suppress.mockRestore();
  });

  it('runs mutationMiddleware on PUT and DELETE before handler', async () => {
    const service = createService();
    service.update.mockResolvedValue(sample);
    service.delete.mockResolvedValue(true);
    const seen: string[] = [];
    const marker: express.RequestHandler = (_req, _res, next) => {
      seen.push('marker');
      next();
    };
    const app = buildApp(service, { mutationMiddleware: [marker] });
    await request(app).put('/items/1').send({ name: 'a' });
    await request(app).delete('/items/1');
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });
});

describe('createCrudRouter — idType=string for custom primary keys', () => {
  interface StringIdItem {
    id: string;
    uuid?: string;
    key: string;
    first_name: string;
    last_name: string;
  }
  function createStringPkService(): jest.Mocked<IEntityService<StringIdItem>> {
    return createMockCrudService<StringIdItem>(new PrimaryKey('id', 'string'));
  }
  function buildStringPkApp(service: jest.Mocked<IEntityService<StringIdItem>>) {
    const createSchema = z.object({
      key: z.string(),
      first_name: z.string(),
      last_name: z.string(),
    });
    const updateSchema = z.object({
      first_name: z.string().optional(),
      last_name: z.string().optional(),
    });
    const router = createCrudRouter<StringIdItem>({
      service,
      createSchema,
      updateSchema,
      entityName: 'LegacyContact',
    });
    const app = express();
    app.use(express.json());
    app.use('/legacy-contacts', router);
    app.use(errorHandler);
    return app;
  }
  const sampleStringPk: StringIdItem = {
    id: 'cnt-001',
    key: 'cnt-001',
    first_name: 'Ada',
    last_name: 'Lovelace',
  };

  it('GET /:id accepts a non-numeric key (regression: previously rejected with "must be a positive integer")', async () => {
    const service = createStringPkService();
    service.findById.mockResolvedValue(sampleStringPk);
    const res = await request(buildStringPkApp(service)).get('/legacy-contacts/cnt-001');
    expect(res.status).toBe(200);
    expect(service.findById).toHaveBeenCalledWith('cnt-001');
    expect(res.body).toEqual(sampleStringPk);
  });

  it('PUT /:id passes the string key to service.update unchanged', async () => {
    const service = createStringPkService();
    service.update.mockResolvedValue({ ...sampleStringPk, last_name: 'Updated' });
    const res = await request(buildStringPkApp(service))
      .put('/legacy-contacts/cnt-001')
      .send({ last_name: 'Updated' });
    expect(res.status).toBe(200);
    expect(service.update).toHaveBeenCalledWith('cnt-001', { last_name: 'Updated' });
  });

  it('DELETE /:id passes the string key to service.delete unchanged', async () => {
    const service = createStringPkService();
    service.delete.mockResolvedValue(true);
    const res = await request(buildStringPkApp(service)).delete('/legacy-contacts/cnt-001');
    expect(res.status).toBe(200);
    expect(service.delete).toHaveBeenCalledWith('cnt-001');
  });

  it('GET /:id with an empty-string id returns 400 with "must be a non-empty string"', async () => {
    const service = createStringPkService();
    service.findById.mockResolvedValue(null);
    const res = await request(buildStringPkApp(service)).get('/legacy-contacts/cnt-missing');
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });
});

describe('createCrudRouter — idType=uuid for uuid-keyed entities', () => {
  interface UuidItem {
    id: string;
    uuid: string;
    name: string;
  }
  function createUuidService(): jest.Mocked<IEntityService<UuidItem>> {
    return createMockCrudService<UuidItem>(new PrimaryKey('id', 'uuid'));
  }
  function buildUuidApp(service: jest.Mocked<IEntityService<UuidItem>>) {
    const createSchema = z.object({ name: z.string() });
    const updateSchema = z.object({ name: z.string() });
    const router = createCrudRouter<UuidItem>({
      service,
      createSchema,
      updateSchema,
      entityName: 'UuidItem',
    });
    const app = express();
    app.use(express.json());
    app.use('/things', router);
    app.use(errorHandler);
    return app;
  }
  const sampleUuid = '11111111-1111-4111-8111-111111111111';

  it('GET /:id accepts a canonical uuid', async () => {
    const service = createUuidService();
    service.findById.mockResolvedValue({ id: sampleUuid, uuid: sampleUuid, name: 'x' });
    const res = await request(buildUuidApp(service)).get(`/things/${sampleUuid}`);
    expect(res.status).toBe(200);
    expect(service.findById).toHaveBeenCalledWith(sampleUuid);
  });

  it('GET /:id rejects a malformed uuid with "must be a valid uuid"', async () => {
    const service = createUuidService();
    const res = await request(buildUuidApp(service)).get('/things/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toMatch(/uuid/);
  });
});

describe('createCrudRouter — useOptimisticConcurrency + If-Match', () => {
  function buildOccApp(service: jest.Mocked<IEntityService<Item>>) {
    const createSchema = z.object({ name: z.string() });
    const updateSchema = z.object({ name: z.string() });
    const router = createCrudRouter<Item>({
      service,
      createSchema,
      updateSchema,
      entityName: 'Item',
      useOptimisticConcurrency: true,
    });
    const app = express();
    app.use(express.json());
    app.use('/items', router);
    app.use(errorHandler);
    return app;
  }

  it('PUT /:id without If-Match returns 428 PRECONDITION_REQUIRED', async () => {
    const service = createService();
    const res = await request(buildOccApp(service)).put('/items/1').send({ name: 'b' });
    expect(res.status).toBe(428);
    expect(res.body.errors[0].code).toBe('PRECONDITION_REQUIRED');
    expect(service.update).not.toHaveBeenCalled();
  });

  it('PATCH /:id without If-Match returns 428', async () => {
    const service = createService();
    const res = await request(buildOccApp(service)).patch('/items/1').send({ name: 'b' });
    expect(res.status).toBe(428);
    expect(service.patch).not.toHaveBeenCalled();
  });

  it('DELETE /:id without If-Match returns 428', async () => {
    const service = createService();
    const res = await request(buildOccApp(service)).delete('/items/1');
    expect(res.status).toBe(428);
    expect(service.delete).not.toHaveBeenCalled();
  });

  it('PUT /:id with If-Match passes expectedUpdated to service.update', async () => {
    const service = createService();
    service.update.mockResolvedValue({ ...sample, name: 'b', updated: 'new-stamp' });
    const res = await request(buildOccApp(service))
      .put('/items/1')
      .set('If-Match', 'old-stamp')
      .send({ name: 'b' });
    expect(res.status).toBe(200);
    expect(service.update).toHaveBeenCalledWith(1, { name: 'b' }, { expectedUpdated: 'old-stamp' });
  });

  it('DELETE /:id with If-Match passes expectedUpdated to service.delete', async () => {
    const service = createService();
    service.delete.mockResolvedValue(true);
    const res = await request(buildOccApp(service)).delete('/items/1').set('If-Match', 'old-stamp');
    expect(res.status).toBe(200);
    expect(service.delete).toHaveBeenCalledWith(1, { expectedUpdated: 'old-stamp' });
  });

  it('PUT /:id strips wrapping quotes from If-Match per RFC 9110', async () => {
    const service = createService();
    service.update.mockResolvedValue({ ...sample, name: 'b' });
    const res = await request(buildOccApp(service))
      .put('/items/1')
      .set('If-Match', '"old-stamp"')
      .send({ name: 'b' });
    expect(res.status).toBe(200);
    expect(service.update).toHaveBeenCalledWith(1, { name: 'b' }, { expectedUpdated: 'old-stamp' });
  });

  it('without useOptimisticConcurrency, If-Match is ignored', async () => {
    const service = createService();
    service.update.mockResolvedValue({ ...sample, name: 'b' });
    const res = await request(buildApp(service))
      .put('/items/1')
      .set('If-Match', 'stamp')
      .send({ name: 'b' });
    expect(res.status).toBe(200);
    expect(service.update).toHaveBeenCalledWith(1, { name: 'b' });
  });

  it('PATCH /:id with If-Match passes expectedUpdated to service.patch', async () => {
    const service = createService();
    service.patch.mockResolvedValue({ ...sample, name: 'b', updated: 'new-stamp' });
    const res = await request(buildOccApp(service))
      .patch('/items/1')
      .set('If-Match', 'old-stamp')
      .send({ name: 'b' });
    expect(res.status).toBe(200);
    expect(service.patch).toHaveBeenCalledWith(1, { name: 'b' }, { expectedUpdated: 'old-stamp' });
  });

  it('PUT /:id with empty If-Match returns 428', async () => {
    const service = createService();
    const res = await request(buildOccApp(service))
      .put('/items/1')
      .set('If-Match', '')
      .send({ name: 'b' });
    expect(res.status).toBe(428);
    expect(service.update).not.toHaveBeenCalled();
  });
});

describe('createCrudRouter — primaryKeyParam (custom URL parameter name)', () => {
  interface KeyedRow {
    id: string;
    code: string;
    name: string;
  }
  function createKeyedService(): jest.Mocked<IEntityService<KeyedRow>> {
    return createMockCrudService<KeyedRow>(new PrimaryKey('code', 'string'));
  }
  function buildCodeApp(service: jest.Mocked<IEntityService<KeyedRow>>) {
    const createSchema = z.object({ name: z.string() });
    const updateSchema = z.object({ name: z.string() });
    const router = createCrudRouter<KeyedRow>({
      service,
      createSchema,
      updateSchema,
      entityName: 'Widget',
    });
    const app = express();
    app.use(express.json());
    app.use('/widgets', router);
    app.use(errorHandler);
    return app;
  }

  it('GET /:code passes req.params.code (not req.params.id) to service.findById', async () => {
    const service = createKeyedService();
    service.findById.mockResolvedValue({ id: 'WID-1', code: 'WID-1', name: 'A' });
    const res = await request(buildCodeApp(service)).get('/widgets/WID-1');
    expect(res.status).toBe(200);
    expect(service.findById).toHaveBeenCalledWith('WID-1');
  });

  it('PUT /:code routes through with the captured string and updates service.update', async () => {
    const service = createKeyedService();
    service.update.mockResolvedValue({ id: 'WID-1', code: 'WID-1', name: 'B' });
    const res = await request(buildCodeApp(service)).put('/widgets/WID-1').send({ name: 'B' });
    expect(res.status).toBe(200);
    expect(service.update).toHaveBeenCalledWith('WID-1', { name: 'B' });
  });

  it('DELETE /:code uses the custom param name', async () => {
    const service = createKeyedService();
    service.delete.mockResolvedValue(true);
    const res = await request(buildCodeApp(service)).delete('/widgets/WID-1');
    expect(res.status).toBe(200);
    expect(service.delete).toHaveBeenCalledWith('WID-1');
  });

  it('list route GET / is unaffected by primaryKeyParam', async () => {
    const service = createKeyedService();
    service.findAll.mockResolvedValue([
      { id: 'WID-1', code: 'WID-1', name: 'A' },
      { id: 'WID-2', code: 'WID-2', name: 'B' },
    ]);
    const res = await request(buildCodeApp(service)).get('/widgets');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });
});
