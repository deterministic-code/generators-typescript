import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { useCrudApp } from './_createBackendAppKit';

const DATASOURCE_DATA = {
  types: [
    {
      member: {
        target: 'Crud',
        fields: [
          { id: { type: 'uuid' } },
          { handle: { type: 'string', size: 64, is_unique: true } },
          { display_name: { type: 'string', size: 128 } },
          { bio: { type: 'string', size: 'unlimited', is_nullable: true } },
        ],
      },
    },
  ],
};

const ROUTES_DATA = {
  includes: [{ view_type_routes: { filter: 'type inherits datasource_types' } }],
  routes: [],
};

// An authored uuid `id` field: the primary key IS the uuid, so the table carries no separate `uuid` column.
const TEST_DDL = `CREATE TABLE "member" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "handle" VARCHAR(64) NOT NULL UNIQUE,
  "display_name" VARCHAR(128) NOT NULL,
  "bio" TEXT,
  "created" TEXT NOT NULL DEFAULT (datetime('now')),
  "updated" TEXT NOT NULL DEFAULT (datetime('now'))
);`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('createBackendApp — authored uuid id end-to-end via Express', () => {
  const getApp = useCrudApp({
    datasourceData: DATASOURCE_DATA,
    routesData: ROUTES_DATA,
    ddl: TEST_DDL,
    settingsConfig: {
      pluralizeTableNames: false,
    },
  });

  let created: string;

  it('POST /api/member returns 201 with a string uuid id (regression: was 500 resolveInsertedRow row id=0)', async () => {
    const res = await request(getApp())
      .post('/api/members')
      .send({ handle: 'alice', display_name: 'Alice', bio: 'hi' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(typeof res.body.id).toBe('string');
    expect(res.body.id).toMatch(UUID_RE);
    expect(res.body).not.toHaveProperty('uuid');
    created = res.body.id;
  });

  it('GET /api/members/{uuid} returns the row (regression: `/:id` was validated as integer → 400)', async () => {
    const res = await request(getApp()).get(`/api/members/${created}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.id).toBe(created);
    expect(res.body.handle).toBe('alice');
  });

  it('GET /api/members/{uuid} for an absent uuid returns 404, not a 400 integer-validation error', async () => {
    const res = await request(getApp()).get('/api/members/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});
