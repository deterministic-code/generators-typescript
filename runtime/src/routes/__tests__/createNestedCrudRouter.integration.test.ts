import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { createNestedCrudRouter } from '../createNestedCrudRouter';
import { EntityIdentity } from '../../repositories/EntityIdentity';
import { PrimaryKey } from '../../repositories/PrimaryKey';
import type { RouteIdType } from '../routeParamUtils';
import { errorHandler } from '../../middleware/errorHandler';
import type { IEntityService } from '../../services/interfaces/IEntityService';
import { createMockCrudService } from './_crudRouterKit';

interface Child {
  id: number;
  uuid: string;
  user_id: number;
  title: string;
  created: string;
  updated: string;
}

const createService = () => createMockCrudService<Child>();

function buildApp(
  service: jest.Mocked<IEntityService<Child>>,
  overrides: Partial<{
    createSchema: z.ZodSchema;
    updateSchema: z.ZodSchema;
    patchSchema: z.ZodSchema;
    idType: RouteIdType;
  }> = {},
) {
  const createSchema = overrides.createSchema ?? z.object({ title: z.string() });
  const updateSchema = overrides.updateSchema ?? z.object({ title: z.string() });
  const idType = overrides.idType ?? service.primaryKey.idType;
  (service as unknown as { primaryKey: EntityIdentity }).primaryKey =
    EntityIdentity.scalar('id', idType);
  const router = createNestedCrudRouter<Child>({
    service,
    createSchema,
    updateSchema,
    patchSchema: overrides.patchSchema,
    parentParamName: 'userId',
    parentFkField: 'user_id',
    parentEntityName: 'User',
    entityName: 'Article',
    parentPrimaryKey: EntityIdentity.scalar('id', idType),
  });
  const app = express();
  app.use(express.json());
  app.use('/users/:userId/articles', router);
  app.use(errorHandler);
  return app;
}

const sampleChild: Child = {
  id: 1,
  uuid: 'u1',
  user_id: 10,
  title: 'Test Article',
  created: 't',
  updated: 't',
};

function expectOneArticle(res: { status: number; body: { items: Array<{ id: number }> } }): void {
  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(1);
  expect(res.body.items[0].id).toBe(1);
}

describe('createNestedCrudRouter', () => {
  it('GET / lists only items matching parentFkField', async () => {
    const service = createService();
    service.findAll.mockResolvedValue([
      sampleChild,
      { id: 2, uuid: 'u2', user_id: 20, title: 'Other Article', created: 't', updated: 't' },
    ]);
    expectOneArticle(await request(buildApp(service)).get('/users/10/articles'));
  });

  it('GET / returns empty array when no matching items', async () => {
    const service = createService();
    service.findAll.mockResolvedValue([
      { id: 2, uuid: 'u2', user_id: 20, title: 'Other Article', created: 't', updated: 't' },
    ]);
    const res = await request(buildApp(service)).get('/users/10/articles');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it("GET / accepts a uuid parent path param when idType is 'uuid' (was 400 under the hardcoded positive-integer parse)", async () => {
    const parentUuid = '00000000-0000-0000-0000-000000000010';
    const service = createService();
    const uuidChild = {
      ...sampleChild,
      user_id: parentUuid as unknown as number,
    };
    service.findAll.mockResolvedValue([uuidChild]);
    expectOneArticle(
      await request(buildApp(service, { idType: 'uuid' })).get(`/users/${parentUuid}/articles`),
    );
  });

  it("GET / still 400s a non-uuid parent path param when idType is 'uuid'", async () => {
    const service = createService();
    const res = await request(buildApp(service, { idType: 'uuid' })).get('/users/10/articles');
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('GET / returns 400 for non-numeric parent param', async () => {
    const service = createService();
    const res = await request(buildApp(service)).get('/users/abc/articles');
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('GET /:id returns 404 when item belongs to different parent', async () => {
    const service = createService();
    const differentOwner = { ...sampleChild, user_id: 20 };
    service.findAll.mockResolvedValue([differentOwner]);
    const res = await request(buildApp(service)).get('/users/10/articles/1');
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('GET /:id returns 400 for bad child id', async () => {
    const service = createService();
    const res = await request(buildApp(service)).get('/users/10/articles/0');
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('GET /:id returns the item when ownership matches', async () => {
    const service = createService();
    service.findAll.mockResolvedValue([sampleChild]);
    const res = await request(buildApp(service)).get('/users/10/articles/1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(sampleChild);
  });

  it('POST / injects parentFkField into create data', async () => {
    const service = createService();
    const created = { ...sampleChild, id: 5 };
    service.create.mockResolvedValue(created);
    const res = await request(buildApp(service))
      .post('/users/10/articles')
      .send({ title: 'New Article' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 10, title: 'New Article' }),
    );
  });

  it('POST / returns 400 for invalid body', async () => {
    const service = createService();
    const res = await request(buildApp(service)).post('/users/10/articles').send({ title: 42 });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('POST / returns 400 for non-numeric parent param', async () => {
    const service = createService();
    const res = await request(buildApp(service))
      .post('/users/invalid/articles')
      .send({ title: 'Test' });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('PUT /:id returns 404 when item belongs to different parent', async () => {
    const service = createService();
    const differentOwner = { ...sampleChild, user_id: 20 };
    service.findAll.mockResolvedValue([differentOwner]);
    const res = await request(buildApp(service))
      .put('/users/10/articles/1')
      .send({ title: 'Updated' });
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('PUT /:id returns 404 when item not found', async () => {
    const service = createService();
    service.findAll.mockResolvedValue([]);
    service.update.mockResolvedValue(null);
    const res = await request(buildApp(service))
      .put('/users/10/articles/999')
      .send({ title: 'Updated' });
    expect(res.status).toBe(404);
  });

  it('PUT /:id updates the item when ownership matches', async () => {
    const service = createService();
    const updated = { ...sampleChild, title: 'Updated Title' };
    service.findAll.mockResolvedValue([sampleChild]);
    service.update.mockResolvedValue(updated);
    const res = await request(buildApp(service))
      .put('/users/10/articles/1')
      .send({ title: 'Updated Title' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(updated);
  });

  it('PUT /:id pins parentFkField to the path parent — body cannot reassign ownership', async () => {
    const service = createService();
    service.findAll.mockResolvedValue([sampleChild]);
    service.update.mockResolvedValue({ ...sampleChild, title: 'Reassigned' });
    await request(buildApp(service))
      .put('/users/10/articles/1')
      .send({ title: 'Reassigned', user_id: 999 });
    expect(service.update).toHaveBeenCalledTimes(1);
    const updateArgs = service.update.mock.calls[0];
    expect(updateArgs[0]).toBe(1);
    expect(updateArgs[1].user_id).toBe(10);
  });

  it('DELETE /:id returns 404 when item belongs to different parent', async () => {
    const service = createService();
    const differentOwner = { ...sampleChild, user_id: 20 };
    service.findAll.mockResolvedValue([differentOwner]);
    const res = await request(buildApp(service)).delete('/users/10/articles/1');
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('DELETE /:id returns 404 when item not found', async () => {
    const service = createService();
    service.findAll.mockResolvedValue([]);
    service.delete.mockResolvedValue(false);
    const res = await request(buildApp(service)).delete('/users/10/articles/999');
    expect(res.status).toBe(404);
  });

  it('DELETE /:id deletes the item when ownership matches', async () => {
    const service = createService();
    service.findAll.mockResolvedValue([sampleChild]);
    service.delete.mockResolvedValue(true);
    const res = await request(buildApp(service)).delete('/users/10/articles/1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('POST / accepts body without parentFkField when schema marks it required', async () => {
    const service = createService();
    const created = { ...sampleChild, id: 5 };
    service.create.mockResolvedValue(created);
    const createSchema = z.object({ title: z.string(), user_id: z.number() });
    const res = await request(buildApp(service, { createSchema }))
      .post('/users/10/articles')
      .send({ title: 'New Article' });
    expect(res.status).toBe(201);
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 10, title: 'New Article' }),
    );
  });

  it('POST / pins parentFkField to the path parent — body cannot reassign ownership', async () => {
    const service = createService();
    service.create.mockResolvedValue({ ...sampleChild, id: 5 });
    const createSchema = z.object({ title: z.string(), user_id: z.number() });
    await request(buildApp(service, { createSchema }))
      .post('/users/10/articles')
      .send({ title: 'New Article', user_id: 999 });
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 10, title: 'New Article' }),
    );
  });

  it('PUT /:id accepts body without parentFkField when schema marks it required', async () => {
    const service = createService();
    const updated = { ...sampleChild, title: 'Updated' };
    service.findAll.mockResolvedValue([sampleChild]);
    service.update.mockResolvedValue(updated);
    const updateSchema = z.object({ title: z.string(), user_id: z.number() });
    const res = await request(buildApp(service, { updateSchema }))
      .put('/users/10/articles/1')
      .send({ title: 'Updated' });
    expect(res.status).toBe(200);
    expect(service.update).toHaveBeenCalledWith(1, expect.objectContaining({ user_id: 10 }));
  });
});

describe('createNestedCrudRouter — composite child identity', () => {
  interface LinkChild {
    left_id: number;
    right_id: number;
    user_id: number;
    label: string;
  }

  it('GET /:left_id/:right_id finds the child by both keys', async () => {
    const service = createMockCrudService<LinkChild>(
      EntityIdentity.of([
        new PrimaryKey('left_id', 'integer'),
        new PrimaryKey('right_id', 'integer'),
      ]),
    );
    const row: LinkChild = { left_id: 1, right_id: 2, user_id: 10, label: 'ab' };
    service.findAll.mockResolvedValue([row]);
    const router = createNestedCrudRouter<LinkChild>({
      service,
      createSchema: z.object({ label: z.string() }),
      updateSchema: z.object({ label: z.string() }),
      parentParamName: 'userId',
      parentFkField: 'user_id',
      parentEntityName: 'User',
      entityName: 'Link',
      parentPrimaryKey: EntityIdentity.scalar('id', 'integer'),
    });
    const app = express();
    app.use(express.json());
    app.use('/users/:userId/links', router);
    app.use(errorHandler);
    const res = await request(app).get('/users/10/links/1/2');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ left_id: 1, right_id: 2, label: 'ab' }));
  });
});
