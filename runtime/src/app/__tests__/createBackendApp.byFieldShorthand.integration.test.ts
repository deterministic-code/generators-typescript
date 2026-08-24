// Integration coverage for the by-field shorthand at the createBackendApp layer: drive a sqlite-backed Express app where routes.yaml declares every supported shorthand form (bare string, `{ name: null }` map, get_/put_/delete_ prefixes) and confirm the resulting Express endpoints dispatch GET/PUT/DELETE correctly. Mirrors rust/tests/byfield_routes_methods_integration.rs so divergence between runtimes surfaces in either suite.

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { useCrudApp } from './_createBackendAppKit';

const DATASOURCE_DATA = {
  types: [
    {
      widget: {
        skip_migrations: true,
        target: 'Crud',
        fields: [
          { key: { type: 'string', size: 64, primary_key: true } },
          { tag: { type: 'string', size: 64 } },
        ],
      },
    },
  ],
};

const ROUTES_DATA = {
  includes: [{ view_type_routes: { filter: 'type inherits datasource_types' } }],
  routes: [
    // bare-string shorthand on a unique field (the PK is treated as unique)
    'widgets_by_key',
    // `{ name: null }` map form on a non-unique field — explicit PUT only
    { put_widgets_by_tag: null },
    // explicit delete_ prefix on a non-unique field
    'delete_widgets_by_tag',
    // explicit get_ prefix on a non-unique field
    'get_widgets_by_tag',
  ],
};

const TEST_DDL = `CREATE TABLE "widgets" (
  "key" VARCHAR(64) NOT NULL PRIMARY KEY,
  "tag" VARCHAR(64) NOT NULL
);`;

describe('createBackendApp — byField shorthand end-to-end via Express', () => {
  const getApp = useCrudApp({
    datasourceData: DATASOURCE_DATA,
    routesData: ROUTES_DATA,
    ddl: TEST_DDL,
    settingsConfig: {},
    onCrudSpecs: (crudSpecs) => {
      const widgetSpec = crudSpecs.find((s) => s.entityName === 'widget');
      if (!widgetSpec) throw new Error('widget CRUD spec missing — parser dropped the entity');
      if (!widgetSpec.byFields || widgetSpec.byFields.length === 0) {
        throw new Error('widget byFields empty — shorthand parsing failed');
      }
    },
  });

  async function seedRow(key: string, tag: string): Promise<void> {
    const res = await request(getApp()).post('/api/widgets').send({ key, tag });
    expect(
      res.status,
      `POST /api/widgets failed: status=${res.status} body=${JSON.stringify(res.body)}`,
    ).toBe(201);
  }

  it('bare-string shorthand on PK field exposes GET/PUT/DELETE', async () => {
    await seedRow('alpha', 'starter');

    const get = await request(getApp()).get('/api/widgets/key/alpha');
    expect(get.status, JSON.stringify(get.body)).toBe(200);
    expect(get.body.key).toBe('alpha');

    const put = await request(getApp()).put('/api/widgets/key/alpha').send({ tag: 'updated' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.tag).toBe('updated');

    const del = await request(getApp()).delete('/api/widgets/key/alpha');
    expect(del.status).toBe(204);

    const after = await request(getApp()).get('/api/widgets/key/alpha');
    expect(after.status).toBe(404);
  });

  it('put_ prefix on non-unique field returns the count envelope', async () => {
    await seedRow('p1', 'batch');
    await seedRow('p2', 'batch');
    await seedRow('p3', 'batch');

    const put = await request(getApp()).put('/api/widgets/tag/batch').send({ tag: 'renamed' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.count).toBe(3);

    const get = await request(getApp()).get('/api/widgets/tag/renamed');
    expect(get.status).toBe(200);
    expect(get.body.items?.length).toBe(3);
  });

  it('delete_ prefix on non-unique field returns the count envelope', async () => {
    await seedRow('d1', 'toast');
    await seedRow('d2', 'toast');

    const del = await request(getApp()).delete('/api/widgets/tag/toast');
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(del.body.count).toBe(2);
  });

  it('get_ prefix on non-unique field returns the items envelope', async () => {
    await seedRow('g1', 'visible');
    const res = await request(getApp()).get('/api/widgets/tag/visible');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('GET by unique key returns 404 when no row matches', async () => {
    const res = await request(getApp()).get('/api/widgets/key/no-such-widget');
    expect(res.status).toBe(404);
    expect(res.body.errors?.[0]?.code).toBe('NOT_FOUND');
  });

  it('PUT by unique key returns 404 when no row matches', async () => {
    const res = await request(getApp()).put('/api/widgets/key/no-such-widget').send({ tag: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.errors?.[0]?.code).toBe('NOT_FOUND');
  });
});
