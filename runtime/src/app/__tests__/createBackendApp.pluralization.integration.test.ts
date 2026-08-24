import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { bootCrudApp } from './_createBackendAppKit';

const ROUTES_DATA = {
  includes: [{ view_type_routes: { filter: 'type inherits datasource_types' } }],
  routes: [],
};

async function buildApp(
  datasourceData: unknown,
  ddl: string[],
  pluralize: boolean,
): Promise<{ app: Express; close: () => Promise<void> }> {
  const { app, cleanup } = await bootCrudApp({
    datasourceData,
    routesData: ROUTES_DATA,
    ddl,
    settingsConfig: { pluralizeTableNames: pluralize },
  });
  return { app, close: cleanup };
}

describe('createBackendApp — pluralize_datatable_names: true (single entity)', () => {
  let app: Express;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const ds = {
      types: [
        {
          widget: {
            target: 'Crud',
            fields: [
              { name: { type: 'string', size: 256 } },
              { category: { type: 'string', size: 64 } },
            ],
          },
        },
      ],
    };
    const built = await buildApp(
      ds,
      [
        `CREATE TABLE "widgets" (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT,
          name TEXT,
          category TEXT,
          created TEXT,
          updated TEXT
        )`,
      ],
      true,
    );
    app = built.app;
    close = built.close;
  });

  afterAll(async () => {
    await close();
  });

  it('POST /api/widgets inserts into the pluralized "widgets" table', async () => {
    const res = await request(app).post('/api/widgets').send({ name: 'one', category: 'A' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.name).toBe('one');
  });

  it('GET /api/widgets reads from the pluralized "widgets" table', async () => {
    const res = await request(app).get('/api/widgets');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
  });
});

describe('createBackendApp — pluralize_datatable_names: true (multi-token entity user_type → user_types)', () => {
  let app: Express;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const ds = {
      types: [
        {
          user_type: {
            target: 'Crud',
            fields: [{ label: { type: 'string', size: 64 } }],
          },
        },
      ],
    };
    const built = await buildApp(
      ds,
      [
        `CREATE TABLE "user_types" (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT,
          label TEXT,
          created TEXT,
          updated TEXT
        )`,
      ],
      true,
    );
    app = built.app;
    close = built.close;
  });

  afterAll(async () => {
    await close();
  });

  it('POST /api/user-types inserts into "user_types" (last token pluralized)', async () => {
    const res = await request(app).post('/api/user-types').send({ label: 'admin' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.label).toBe('admin');
  });

  it('GET /api/user-types returns rows from "user_types"', async () => {
    const res = await request(app).get('/api/user-types');
    expect(res.status).toBe(200);
    expect(res.body.items[0].label).toBe('admin');
  });
});

describe('createBackendApp — pluralize_datatable_names: false (singular preserved)', () => {
  let app: Express;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const ds = {
      types: [
        {
          widget: {
            target: 'Crud',
            fields: [{ name: { type: 'string', size: 256 } }],
          },
        },
      ],
    };
    const built = await buildApp(
      ds,
      [
        `CREATE TABLE "widget" (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT,
          name TEXT,
          created TEXT,
          updated TEXT
        )`,
      ],
      false,
    );
    app = built.app;
    close = built.close;
  });

  afterAll(async () => {
    await close();
  });

  it('POST /api/widgets inserts into the singular "widget" table when pluralize is off', async () => {
    const res = await request(app).post('/api/widgets').send({ name: 'one' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe('createBackendApp — pluralize_datatable_names + datasource_mappings.source override', () => {
  let app: Express;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const ds = {
      types: [
        {
          widget: {
            target: 'Crud',
            fields: [{ name: { type: 'string', size: 256 } }],
          },
        },
      ],
      datasource_mappings: [{ widget: { source: 'OldWidgetsTbl' } }],
    };
    const built = await buildApp(
      ds,
      [
        `CREATE TABLE "OldWidgetsTbl" (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT,
          name TEXT,
          created TEXT,
          updated TEXT
        )`,
      ],
      true,
    );
    app = built.app;
    close = built.close;
  });

  afterAll(async () => {
    await close();
  });

  it('datasource_mappings.source wins over pluralization (uses OldWidgetsTbl verbatim)', async () => {
    const res = await request(app).post('/api/widgets').send({ name: 'mapped' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe('createBackendApp — pluralization + many-to-one FK lookup (user → user_type)', () => {
  let app: Express;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const ds = {
      types: [
        {
          user_type: {
            target: 'Crud',
            fields: [{ label: { type: 'string', size: 64 } }],
          },
        },
        {
          user: {
            target: 'Crud',
            fields: [
              { name: { type: 'string', size: 256 } },
              {
                user_type_id: {
                  type: 'integer',
                  references: 'datasource_types.user_type.id',
                },
              },
            ],
          },
        },
      ],
    };
    const built = await buildApp(
      ds,
      [
        `CREATE TABLE "user_types" (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT,
          label TEXT,
          created TEXT,
          updated TEXT
        )`,
        `CREATE TABLE "users" (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT,
          name TEXT,
          user_type_id INTEGER,
          created TEXT,
          updated TEXT,
          FOREIGN KEY(user_type_id) REFERENCES user_types(id)
        )`,
      ],
      true,
    );
    app = built.app;
    close = built.close;
  });

  afterAll(async () => {
    await close();
  });

  it('POST /api/user-types succeeds against "user_types"', async () => {
    const res = await request(app).post('/api/user-types').send({ label: 'admin' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.id).toBeGreaterThan(0);
  });

  it('POST /api/users with a valid user_type_id succeeds (FK target table is pluralized)', async () => {
    const ut = await request(app).post('/api/user-types').send({ label: 'staff' });
    expect(ut.status, JSON.stringify(ut.body)).toBe(201);
    const res = await request(app)
      .post('/api/users')
      .send({ name: 'Alice', user_type_id: ut.body.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.name).toBe('Alice');
  });
});

describe('createBackendApp — already-plural entity name registers /api/<name> (no double-pluralize)', () => {
  let app: Express;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const ds = {
      types: [
        {
          tokens: {
            target: 'Crud',
            fields: [{ name: { type: 'string', size: 256 } }],
          },
        },
      ],
    };
    const built = await buildApp(
      ds,
      [
        `CREATE TABLE "tokens" (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT,
          name TEXT,
          created TEXT,
          updated TEXT
        )`,
      ],
      true,
    );
    app = built.app;
    close = built.close;
  });

  afterAll(async () => {
    await close();
  });

  it('POST /api/tokens serves the flat route (not double-pluralized /api/tokenses)', async () => {
    const res = await request(app).post('/api/tokens').send({ name: 'one' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.name).toBe('one');
  });

  it('GET /api/tokens reads back the row', async () => {
    const res = await request(app).get('/api/tokens');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('the double-pluralized /api/tokenses is not registered', async () => {
    const res = await request(app).get('/api/tokenses');
    expect(res.status).toBe(404);
  });
});
