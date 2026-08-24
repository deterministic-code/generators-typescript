import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { bootCrudApp } from './_createBackendAppKit';

const DATASOURCE_DATA = {
  types: [
    {
      notification: {
        skip_migrations: true,
        target: 'Crud',
        fields: [
          { key: { type: 'string', size: 256, primary_key: true } },
          { uuid: { type: 'string', size: 64 } },
          { text: { type: 'string', size: 'unlimited' } },
          { urgency: { type: 'number', is_nullable: true } },
        ],
      },
    },
  ],
  datasource_mappings: [
    {
      notification: {
        source: 'notifications',
        field_mappings: [
          { key: { source: 'Key' } },
          { uuid: { source: 'guid' } },
          { text: { source: '_data' } },
        ],
      },
    },
  ],
};

const ROUTES_DATA = {
  includes: [{ view_type_routes: { filter: 'type inherits datasource_types' } }],
  routes: [],
};

const TEST_DDL = `CREATE TABLE "notifications" (
  "Key" VARCHAR(256) NOT NULL PRIMARY KEY,
  "guid" VARCHAR(64) NOT NULL,
  "_data" TEXT NOT NULL,
  "urgency" INTEGER
);`;

describe('createBackendApp — datasource_mappings.field_mappings end-to-end via Express', () => {
  let app: Express;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ app, cleanup } = await bootCrudApp({
      datasourceData: DATASOURCE_DATA,
      routesData: ROUTES_DATA,
      ddl: TEST_DDL,
      settingsConfig: {},
    }));
  });

  afterAll(async () => {
    await cleanup();
  });

  it('POST /api/notifications inserts into the physically-mapped columns', async () => {
    const res = await request(app)
      .post('/api/notifications')
      .send({ key: 'n-001', uuid: 'u-1', text: 'hello', urgency: 3 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.key).toBe('n-001');
    expect(res.body.uuid).toBe('u-1');
    expect(res.body.text).toBe('hello');
  });

  it('GET /api/notifications returns rows with logical column names', async () => {
    const res = await request(app).get('/api/notifications');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.items[0].key).toBe('n-001');
    expect(res.body.items[0].uuid).toBe('u-1');
    expect(res.body.items[0].text).toBe('hello');
  });

  it('GET /api/notifications/n-001 returns the row', async () => {
    const res = await request(app).get('/api/notifications/n-001');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.key).toBe('n-001');
  });

  it('PUT /api/notifications/n-001 updates a field-mapped column', async () => {
    const res = await request(app)
      .put('/api/notifications/n-001')
      .send({ text: 'updated text', urgency: 5 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.text).toBe('updated text');
    expect(res.body.urgency).toBe(5);
  });

  it('DELETE /api/notifications/n-001 removes the row', async () => {
    const res = await request(app).delete('/api/notifications/n-001');
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it('GET /api/notifications after DELETE returns empty list (round-trip on mapped columns)', async () => {
    const res = await request(app).get('/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});
