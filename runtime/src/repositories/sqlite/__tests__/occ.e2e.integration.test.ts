import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { SqliteDatasource } from '../SqliteDatasource';
import { SqliteStandardRepository } from '../SqliteStandardRepository';
import { testPrimaryKeys } from '../../__tests__/testPrimaryKeys';
import { EntityService } from '../../../services/EntityService';
import { createCrudRouter } from '../../../routes/createCrudRouter';
import { errorHandler } from '../../../middleware/errorHandler';

interface Item {
  id: number;
  uuid: string;
  name: string;
  created: string;
  updated: string;
}

async function createSchema(ds: SqliteDatasource): Promise<void> {
  await ds.query(
    'CREATE TABLE item (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT, name TEXT, created TEXT, updated TEXT)',
  );
}

function buildApp(
  service: EntityService<Item>,
  options: { useOptimisticConcurrency?: boolean } = {},
): express.Express {
  const createSchemaZ = z.object({ name: z.string() });
  const updateSchemaZ = z.object({ name: z.string() });
  const router = createCrudRouter<Item>({
    service,
    createSchema: createSchemaZ,
    updateSchema: updateSchemaZ,
    entityName: 'Item',
    useOptimisticConcurrency: options.useOptimisticConcurrency,
  });
  const app = express();
  app.use(express.json());
  app.use('/items', router);
  app.use(errorHandler);
  return app;
}

function occApp(ds: SqliteDatasource): express.Express {
  const repo = new SqliteStandardRepository<Item>(ds, 'item', {
    useOptimisticConcurrency: true,
    entityName: 'item',
    primaryKeys: testPrimaryKeys('integer'),
  });
  const service = new EntityService<Item>(repo);
  return buildApp(service, { useOptimisticConcurrency: true });
}

describe('OCC end-to-end on SQLite (router + service + repo + :memory:)', () => {
  let ds: SqliteDatasource;

  beforeEach(async () => {
    ds = new SqliteDatasource({ dbPath: ':memory:' });
    await ds.open();
    await createSchema(ds);
  });

  afterEach(async () => {
    await ds.close();
  });

  it('OCC=off mode: PUT without If-Match returns 200 (header is ignored)', async () => {
    const repo = new SqliteStandardRepository<Item>(ds, 'item', {
      entityName: 'item',
      primaryKeys: testPrimaryKeys('integer'),
    });
    const service = new EntityService<Item>(repo);
    const app = buildApp(service, { useOptimisticConcurrency: false });

    const created = await request(app).post('/items').send({ name: 'Alpha' });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const updated = await request(app).put(`/items/${id}`).send({ name: 'Beta' });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('Beta');
  });

  it('OCC=on: PUT/DELETE without If-Match returns 428 PRECONDITION_REQUIRED', async () => {
    const app = occApp(ds);

    const created = await request(app).post('/items').send({ name: 'Alpha' });
    const id = created.body.id;

    const noHeaderPut = await request(app).put(`/items/${id}`).send({ name: 'Beta' });
    expect(noHeaderPut.status).toBe(428);
    expect(noHeaderPut.body.errors[0].code).toBe('PRECONDITION_REQUIRED');

    const noHeaderDelete = await request(app).delete(`/items/${id}`);
    expect(noHeaderDelete.status).toBe(428);
  });

  it('OCC=on: PUT with current If-Match returns 200 and bumps updated', async () => {
    const app = occApp(ds);

    const created = await request(app).post('/items').send({ name: 'Alpha' });
    const id = created.body.id;
    const originalUpdated = created.body.updated;

    await new Promise((r) => setTimeout(r, 5));

    const ok = await request(app)
      .put(`/items/${id}`)
      .set('If-Match', originalUpdated)
      .send({ name: 'Beta' });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe('Beta');
    expect(ok.body.updated).not.toBe(originalUpdated);
  });

  it('OCC=on: PUT with stale If-Match returns 412 PRECONDITION_FAILED', async () => {
    const app = occApp(ds);

    const created = await request(app).post('/items').send({ name: 'Alpha' });
    const id = created.body.id;

    const stale = await request(app)
      .put(`/items/${id}`)
      .set('If-Match', '1970-01-01T00:00:00.000Z')
      .send({ name: 'Beta' });
    expect(stale.status).toBe(412);
    expect(stale.body.errors[0].code).toBe('PRECONDITION_FAILED');

    const rows = await ds.query<{ name: string }>('SELECT name FROM item WHERE id = ?', [id]);
    expect(rows[0]?.name).toBe('Alpha');
  });

  it('OCC=on: DELETE with stale If-Match returns 412 and row remains', async () => {
    const app = occApp(ds);

    const created = await request(app).post('/items').send({ name: 'Alpha' });
    const id = created.body.id;

    const staleDel = await request(app)
      .delete(`/items/${id}`)
      .set('If-Match', '1970-01-01T00:00:00.000Z');
    expect(staleDel.status).toBe(412);

    const rows = await ds.query<{ id: number }>('SELECT id FROM item WHERE id = ?', [id]);
    expect(rows).toHaveLength(1);
  });

  it('OCC=on: DELETE with current If-Match returns 200 and row is gone', async () => {
    const app = occApp(ds);

    const created = await request(app).post('/items').send({ name: 'Alpha' });
    const id = created.body.id;
    const updated = created.body.updated;

    const ok = await request(app).delete(`/items/${id}`).set('If-Match', updated);
    expect(ok.status).toBe(200);

    const rows = await ds.query<{ id: number }>('SELECT id FROM item WHERE id = ?', [id]);
    expect(rows).toHaveLength(0);
  });

  it('OCC=on: classic two-client race — first writer wins, second gets 412', async () => {
    const app = occApp(ds);

    const created = await request(app).post('/items').send({ name: 'Alpha' });
    const id = created.body.id;
    const sharedUpdated = created.body.updated;

    await new Promise((r) => setTimeout(r, 5));

    const firstWinner = await request(app)
      .put(`/items/${id}`)
      .set('If-Match', sharedUpdated)
      .send({ name: 'WinnerWrite' });
    expect(firstWinner.status).toBe(200);

    const secondLoser = await request(app)
      .put(`/items/${id}`)
      .set('If-Match', sharedUpdated)
      .send({ name: 'LoserWrite' });
    expect(secondLoser.status).toBe(412);

    const rows = await ds.query<{ name: string }>('SELECT name FROM item WHERE id = ?', [id]);
    expect(rows[0]?.name).toBe('WinnerWrite');
  });
});
