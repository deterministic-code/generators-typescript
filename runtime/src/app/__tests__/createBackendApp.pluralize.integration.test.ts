// Regression for `verify sample-contact` (#418): pluralize_datatable_names must be honored end-to-end so runtime queries the plural `contacts` table created by migrations.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { createBackendApp } from '../createBackendApp';
import { connectDatabase } from '../connectDatabase';
import { bootCrudApp, TerminalHandler } from './_createBackendAppKit';
import express from 'express';

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

describe('createBackendApp — inherited mapping wins when pluralize is off', () => {
  let app: Express;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ app, cleanup } = await bootCrudApp({
      datasourceData: {
        types: [
          { base: { tags: ['datasource_type'], fields: [] } },
          {
            contacts_base: {
              tags: ['datasource_type'],
              inherits: 'base',
              fields: [
                { first_name: { type: 'string', size: 128 } },
                { last_name: { type: 'string', size: 128 } },
              ],
            },
          },
          {
            contact: {
              tags: ['view_type'],
              inherits: 'contacts_base',
              fields: [],
            },
          },
        ],
      },
      overlaysDoc: {
        types: [{ contacts_base: { mapping: 'contacts' } }],
      },
      routesData: ROUTES_DATA,
      ddl: PLURAL_DDL,
      settingsConfig: { pluralizeTableNames: false },
    }));
  });

  afterAll(async () => {
    await cleanup();
  });

  it('GET /api/contacts reads the mapped `contacts` table', async () => {
    const res = await request(app).get('/api/contacts');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('POST /api/contacts inserts into the mapped `contacts` table', async () => {
    const res = await request(app)
      .post('/api/contacts')
      .send({ first_name: 'Ada', last_name: 'Lovelace' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.first_name).toBe('Ada');
  });
});

describe('createBackendApp — file overlays + inherit mapping when pluralize is off', () => {
  let app: Express;
  let cleanup: () => Promise<void>;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'contacts-mapping-'));
    const deterministicRoot = path.join(root, 'deterministic');
    await mkdir(deterministicRoot, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(deterministicRoot, 'types.yaml'),
        `types:
  - base:
      tags: [datasource_type]
      fields: []
  - contacts_base:
      tags: [datasource_type]
      inherits: base
      fields:
        - first_name:
            type: string
        - last_name:
            type: string
  - contact:
      tags: [view_type]
      inherits: contacts_base
      fields: []
`,
      ),
      writeFile(
        path.join(deterministicRoot, 'datasource.yaml'),
        `types:
  - contacts_base:
      mapping: contacts
`,
      ),
      writeFile(
        path.join(deterministicRoot, 'settings.yaml'),
        `settings:
  datasource:
    pluralize_datatable_names: false
`,
      ),
      writeFile(path.join(deterministicRoot, 'backend-app.yaml'), `middleware: []\nhandlers: []\n`),
      writeFile(path.join(deterministicRoot, 'services.yaml'), `services: []\n`),
      writeFile(
        path.join(deterministicRoot, 'routes.yaml'),
        `includes:\n  - view_type_routes:\n      filter: type inherits datasource_types\nroutes: []\n`,
      ),
    ]);
    const conn = await connectDatabase({ backend: 'sqlite', databaseUrl: ':memory:' });
    (
      conn.datasource as unknown as { raw: () => { exec: (sql: string) => unknown } }
    ).raw().exec(PLURAL_DDL);
    app = await createBackendApp(conn, {
      deterministicRoot,
      settingsConfig: { pluralizeTableNames: false },
      backendAppConfig: {
        middleware: [{ name: 'bodyParser', type: 'app', enabled: true }],
        handlers: [
          { name: 'ErrorHandlerMiddlewareService', enabled: true },
          { name: 'TerminalHandler', enabled: true },
        ],
      },
      serviceSpecs: [{ name: 'TerminalHandler', args: [] }],
      classRegistry: {
        TerminalHandler: TerminalHandler as unknown as new (...a: unknown[]) => unknown,
      },
      middlewareLookup: { get: () => express.json() } as never,
    });
    cleanup = async () => {
      await conn.close();
      await rm(root, { recursive: true, force: true });
    };
  });

  afterAll(async () => {
    await cleanup();
  });

  it('GET /api/contacts uses datasource.yaml mapping from disk', async () => {
    const res = await request(app).get('/api/contacts');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});
