// Regression for `verify sample-contact` (#418): pluralize_datatable_names must be honored end-to-end so runtime queries the plural `contacts` table created by migrations.

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
          { email: { type: 'string', size: 256, is_nullable: true } },
        ],
      },
    },
  ],
};

const ROUTES_DATA = {
  includes: [{ view_type_routes: { filter: 'type inherits datasource_types' } }],
  routes: [],
};

const PLURAL_DDL = `CREATE TABLE "contacts" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "uuid" VARCHAR(36) NOT NULL UNIQUE,
  "first_name" VARCHAR(128) NOT NULL,
  "last_name" VARCHAR(128) NOT NULL,
  "email" VARCHAR(256),
  "created" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updated" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);`;

describe('createBackendApp — settings.pluralize_datatable_names honored at runtime', () => {
  let app: Express;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ app, cleanup } = await bootCrudApp({
      datasourceData: DATASOURCE_DATA,
      routesData: ROUTES_DATA,
      ddl: PLURAL_DDL,
      settingsConfig: { pluralizeTableNames: true },
    }));
  });

  afterAll(async () => {
    await cleanup();
  });

  it('POST /api/contacts succeeds against the plural `contacts` table', async () => {
    const res = await request(app)
      .post('/api/contacts')
      .send({ first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.first_name).toBe('Ada');
  });

  it('GET /api/contacts returns the inserted row from the plural table', async () => {
    const res = await request(app).get('/api/contacts');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.items[0].first_name).toBe('Ada');
  });
});

describe('createBackendApp — pluralizeTableNames=false preserves singular YAML key', () => {
  let app: Express;
  let cleanup: () => Promise<void>;

  const SINGULAR_DDL = `CREATE TABLE "contact" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "uuid" VARCHAR(36) NOT NULL UNIQUE,
    "first_name" VARCHAR(128) NOT NULL,
    "last_name" VARCHAR(128) NOT NULL,
    "email" VARCHAR(256),
    "created" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`;

  beforeAll(async () => {
    ({ app, cleanup } = await bootCrudApp({
      datasourceData: DATASOURCE_DATA,
      routesData: ROUTES_DATA,
      ddl: SINGULAR_DDL,
      settingsConfig: { pluralizeTableNames: false },
    }));
  });

  afterAll(async () => {
    await cleanup();
  });

  it('POST /api/contacts hits the singular `contact` table when flag is off', async () => {
    const res = await request(app)
      .post('/api/contacts')
      .send({ first_name: 'Grace', last_name: 'Hopper' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.first_name).toBe('Grace');
  });
});
