import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { bootCrudApp } from './_createBackendAppKit';

const DATASOURCE_DATA = {
  types: [
    {
      contact: {
        fields: [
          { first_name: { type: 'string', size: 128 } },
          { last_name: { type: 'string', size: 128 } },
        ],
      },
    },
  ],
};

const ROUTES_DATA = {
  includes: [{ view_type_routes: { filter: 'type inherits datasource_types' } }],
  routes: [],
};

const DDL = `CREATE TABLE "contacts" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "uuid" VARCHAR(36) NOT NULL UNIQUE,
  "first_name" VARCHAR(128) NOT NULL,
  "last_name" VARCHAR(128) NOT NULL,
  "created" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updated" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);`;

describe('createBackendApp — use_optimistic_concurrency honored at runtime', () => {
  let app: Express;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ app, cleanup } = await bootCrudApp({
      datasourceData: DATASOURCE_DATA,
      routesData: ROUTES_DATA,
      ddl: DDL,
      settingsConfig: {
        pluralizeTableNames: true,
        useOptimisticConcurrency: true,
      },
    }));
  });

  afterAll(async () => {
    await cleanup();
  });

  it('PATCH without If-Match returns 428; stale token 412; fresh token succeeds', async () => {
    const created = await request(app)
      .post('/api/contacts')
      .send({ first_name: 'Ada', last_name: 'Lovelace' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as number;
    const token = created.body.updated as string;
    expect(typeof token).toBe('string');

    const missing = await request(app)
      .patch(`/api/contacts/${id}`)
      .send({ first_name: 'No-Match' });
    expect(missing.status, JSON.stringify(missing.body)).toBe(428);

    const stale = await request(app)
      .patch(`/api/contacts/${id}`)
      .set('If-Match', '1970-01-01T00:00:00.000Z')
      .send({ first_name: 'Stale' });
    expect(stale.status, JSON.stringify(stale.body)).toBe(412);

    const fresh = await request(app)
      .patch(`/api/contacts/${id}`)
      .set('If-Match', token)
      .send({ first_name: 'Fresh' });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body.first_name).toBe('Fresh');
  });
});
