import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { useCrudApp } from './_createBackendAppKit';

const DATASOURCE_DATA = {
  types: [
    {
      legacy_contact: {
        skip_migrations: true,
        target: 'Crud',
        fields: [
          { key: { type: 'string', size: 64, primary_key: true } },
          { first_name: { type: 'string', size: 128 } },
          { last_name: { type: 'string', size: 128 } },
        ],
      },
    },
  ],
  datasource_mappings: [
    {
      legacy_contact: {
        source: 'OldContactsTbl',
        field_mappings: [{ key: { source: 'CntID' } }],
      },
    },
  ],
};

const ROUTES_DATA = {
  includes: [{ view_type_routes: { filter: 'type inherits datasource_types' } }],
  routes: [],
};

const TEST_DDL = `CREATE TABLE "OldContactsTbl" (
  "CntID" VARCHAR(64) NOT NULL PRIMARY KEY,
  "first_name" VARCHAR(128) NOT NULL,
  "last_name" VARCHAR(128) NOT NULL
);`;

describe('createBackendApp — custom primary key end-to-end via Express', () => {
  const getApp = useCrudApp({
    datasourceData: DATASOURCE_DATA,
    routesData: ROUTES_DATA,
    ddl: TEST_DDL,
    settingsConfig: {},
  });

  it('POST /api/legacy-contacts creates a row keyed by `key`', async () => {
    const res = await request(getApp())
      .post('/api/legacy-contacts')
      .send({ key: 'cnt-001', first_name: 'Ada', last_name: 'Lovelace' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.key).toBe('cnt-001');
  });

  it('GET /api/legacy-contacts returns the inserted row', async () => {
    const res = await request(getApp()).get('/api/legacy-contacts');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.items[0].key).toBe('cnt-001');
  });

  it('GET /api/legacy-contacts/cnt-001 returns the row (THIS IS THE REGRESSION CASE)', async () => {
    const res = await request(getApp()).get('/api/legacy-contacts/cnt-001');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.key).toBe('cnt-001');
  });

  it('PUT /api/legacy-contacts/cnt-001 updates and matches schema', async () => {
    const res = await request(getApp())
      .put('/api/legacy-contacts/cnt-001')
      .send({ first_name: 'Grace', last_name: 'Hopper' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.first_name).toBe('Grace');
  });

  it('DELETE /api/legacy-contacts/cnt-001 removes the row', async () => {
    const res = await request(getApp()).delete('/api/legacy-contacts/cnt-001');
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });
});
