import { describe, it, beforeAll, expect, vi } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import { createBackendApp } from '../createBackendApp';
import * as repoModule from '../../repositories';
import type { DatabaseConnection } from '../../repositories';
import type { ICrudRepository } from '../../repositories/ICrudRepository';
import { EntityIdentity } from '../../repositories/EntityIdentity';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixtureDir = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'test-samples',
  'kitchen-sink',
  'deterministic',
);

interface Row {
  id: number;
  uuid: string;
  created: string;
  updated: string;
  [key: string]: unknown;
}

function makeService<T extends Row>(rows: T[]): ICrudRepository<T & { id: number }> {
  const store = [...rows];
  return {
    entityName: 'mock',
    primaryKey: EntityIdentity.scalar('id', 'integer'),
    query: vi.fn(async () => []),
    find: vi.fn(async (id: number) => store.find((r) => r.id === id) ?? null),
    findAll: vi.fn(async () => [...store]),
    findBy: vi.fn(async (column: string, value: unknown) =>
      store.filter((r) => String((r as Record<string, unknown>)[column]) === String(value)),
    ),
    findIn: vi.fn(async (column: string, values: ReadonlyArray<unknown>) => {
      const set = new Set(values.map((v) => String(v)));
      return store.filter((r) => set.has(String((r as Record<string, unknown>)[column])));
    }),
    add: vi.fn(async (data: Partial<T>) => {
      const next = { id: store.length + 100, ...data } as T;
      store.push(next);
      return next;
    }),
    update: vi.fn(async (id: number, data: Partial<T>) => {
      const idx = store.findIndex((r) => r.id === id);
      if (idx === -1) return null;
      store[idx] = { ...store[idx], ...data };
      return store[idx];
    }),
    delete: vi.fn(async (id: number) => {
      const idx = store.findIndex((r) => r.id === id);
      if (idx === -1) return false;
      store.splice(idx, 1);
      return true;
    }),
  } as unknown as ICrudRepository<T & { id: number }>;
}

const ts = '2026-01-01T00:00:00Z';

const seeds: Record<string, Row[]> = {
  widget_status: [
    { id: 1, uuid: 'ws1', name: 'draft', description: null, created: ts, updated: ts },
    {
      id: 2,
      uuid: 'ws2',
      name: 'active',
      description: 'Visible to consumers.',
      created: ts,
      updated: ts,
    },
    { id: 3, uuid: 'ws3', name: 'retired', description: null, created: ts, updated: ts },
  ],
  widget: [
    {
      id: 1,
      uuid: 'w1',
      name: 'Alpha',
      widget_status_id: 2,
      code: 'AAA',
      quantity: 1,
      created: ts,
      updated: ts,
    },
    {
      id: 2,
      uuid: 'w2',
      name: 'Beta',
      widget_status_id: 3,
      code: 'BBB',
      quantity: 2,
      created: ts,
      updated: ts,
    },
    {
      id: 3,
      uuid: 'w3',
      name: 'Gamma',
      widget_status_id: 1,
      code: 'CCC',
      quantity: 0,
      created: ts,
      updated: ts,
    },
  ],
  widget_note: [
    {
      id: 101,
      uuid: 'n1',
      widget_id: 1,
      body: 'first note',
      widget_status_id: 2,
      created: ts,
      updated: ts,
    },
    {
      id: 102,
      uuid: 'n2',
      widget_id: 1,
      body: 'second note',
      widget_status_id: 1,
      created: ts,
      updated: ts,
    },
    {
      id: 103,
      uuid: 'n3',
      widget_id: 2,
      body: 'beta note',
      widget_status_id: null,
      created: ts,
      updated: ts,
    },
    {
      id: 104,
      uuid: 'n4',
      widget_id: 99,
      body: 'orphan note of another widget',
      widget_status_id: 2,
      created: ts,
      updated: ts,
    },
  ],
  category: [
    { id: 5, uuid: 'c5', name: 'red', created: ts, updated: ts },
    { id: 7, uuid: 'c7', name: 'blue', created: ts, updated: ts },
    { id: 9, uuid: 'c9', name: 'green', created: ts, updated: ts },
  ],
  widget_category: [
    { id: 1, uuid: 'wc1', widget_id: 1, category_id: 5, created: ts, updated: ts },
    { id: 2, uuid: 'wc2', widget_id: 1, category_id: 7, created: ts, updated: ts },
    { id: 3, uuid: 'wc3', widget_id: 2, category_id: 9, created: ts, updated: ts },
  ],
};

describe('createBackendApp end-to-end against kitchen-sink deterministic/ fixtures', () => {
  let app: Express;

  beforeAll(async () => {
    vi.spyOn(repoModule, 'buildRepoForBackend').mockImplementation(((
      _conn: DatabaseConnection,
      entityName: string,
    ) => makeService(seeds[entityName] ?? [])) as unknown as typeof repoModule.buildRepoForBackend);

    const conn = {
      type: 'memory',
      close: () => Promise.resolve(),
      middlewares: [],
    } as unknown as DatabaseConnection;

    app = await createBackendApp(conn, {
      backendAppConfig: { middleware: [], handlers: [], statics: [] },
      settingsConfig: { pluralizeTableNames: false },
      deterministicRoot: fixtureDir,
      routeSpecs: [],
      serviceSpecs: [],
    });
  });

  it('GET /api/widgets/:id attaches notes (direct-FK) and categories (M2M via widget_category)', async () => {
    const res = await request(app).get('/api/widgets/1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
    expect(res.body.name).toBe('Alpha');

    expect(Array.isArray(res.body.notes)).toBe(true);
    expect(res.body.notes).toHaveLength(2);
    expect(res.body.notes.map((n: Row) => n.body).sort()).toEqual(['first note', 'second note']);

    expect(Array.isArray(res.body.categories)).toBe(true);
    expect(res.body.categories).toHaveLength(2);
    expect(res.body.categories.map((c: Row) => c.name).sort()).toEqual(['blue', 'red']);
    expect(res.body.categories.some((c: Row) => c.name === 'green')).toBe(false);
  });

  function notesByBody(notes: Row[]): Record<string, Row> {
    return Object.fromEntries(notes.map((n) => [n.body, n])) as Record<string, Row>;
  }

  it('GET /api/widgets/:id eager-loaded notes are enriched with widget_status_name from readonly-lookup', async () => {
    const res = await request(app).get('/api/widgets/1');
    expect(res.status).toBe(200);
    const byBody = notesByBody(res.body.notes);
    expect(byBody['first note'].widget_status_name).toBe('active');
    expect(byBody['second note'].widget_status_name).toBe('draft');
  });

  it('GET /api/widgets/:id does not enrich the widget itself (its widget_status_id is typed integer, not number)', async () => {
    const res = await request(app).get('/api/widgets/1');
    expect(res.status).toBe(200);
    expect(res.body.widget_status_id).toBe(2);
    expect(res.body.widget_status_name).toBeUndefined();
  });

  it('GET /api/widgets lists all widgets with eager-loaded notes + categories per row', async () => {
    const res = await request(app).get('/api/widgets');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items).toHaveLength(3);
    const alpha = res.body.items.find((w: Row) => w.id === 1) as Row;
    expect(alpha).toBeDefined();
    expect((alpha.notes as Row[]).map((n) => n.body).sort()).toEqual(['first note', 'second note']);
    expect((alpha.categories as Row[]).map((c) => c.name).sort()).toEqual(['blue', 'red']);
  });

  it('GET /api/widgets list eager-loaded notes carry the readonly-lookup widget_status_name', async () => {
    const res = await request(app).get('/api/widgets');
    expect(res.status).toBe(200);
    const alpha = res.body.items.find((w: Row) => w.id === 1) as Row;
    const byBody = notesByBody(alpha.notes as Row[]);
    expect(byBody['first note'].widget_status_name).toBe('active');
    expect(byBody['second note'].widget_status_name).toBe('draft');
  });

  it('GET /api/widgets list[alpha] matches GET /api/widgets/1 in eager-loaded shape (keys + children)', async () => {
    const listRes = await request(app).get('/api/widgets');
    const singleRes = await request(app).get('/api/widgets/1');
    expect(listRes.status).toBe(200);
    expect(singleRes.status).toBe(200);

    const alphaFromList = listRes.body.items.find((w: Row) => w.id === 1) as Row;
    const alphaSingle = singleRes.body as Row;
    expect(alphaFromList).toBeDefined();

    expect(Object.keys(alphaFromList).sort()).toEqual(Object.keys(alphaSingle).sort());
    expect((alphaFromList.notes as Row[]).length).toBe((alphaSingle.notes as Row[]).length);
    expect((alphaFromList.categories as Row[]).map((c) => c.name).sort()).toEqual(
      (alphaSingle.categories as Row[]).map((c) => c.name).sort(),
    );
  });

  it('GET /api/widgets/:id/categories lists the widget categories via the M2M combined-route subpath', async () => {
    const res = await request(app).get('/api/widgets/1/categories');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.map((c: Row) => c.name).sort()).toEqual(['blue', 'red']);
  });

  it('GET /api/categories/:id returns the bare category row (leaf entity, no eager children)', async () => {
    const res = await request(app).get('/api/categories/5');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(5);
    expect(res.body.name).toBe('red');
    expect(res.body.notes).toBeUndefined();
    expect(res.body.categories).toBeUndefined();
  });

  it('GET /api/widget-statuses/:id returns the readonly-lookup row', async () => {
    const res = await request(app).get('/api/widget-statuses/2');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(2);
    expect(res.body.name).toBe('active');
  });

  it('GET /api/widgets/:id does not leak notes or categories belonging to other widgets', async () => {
    const res = await request(app).get('/api/widgets/1');
    expect(res.status).toBe(200);
    const noteIds = (res.body.notes as Row[]).map((n) => n.id);
    expect(noteIds.sort()).toEqual([101, 102]);
    expect(noteIds).not.toContain(103);
    expect(noteIds).not.toContain(104);
    const categoryNames = (res.body.categories as Row[]).map((c) => c.name);
    expect(categoryNames).not.toContain('green');
  });

  describe('direct-FK list eager-loading (widget.notes on every row)', () => {
    it('GET /api/widgets: every row carries a notes array', async () => {
      const res = await request(app).get('/api/widgets');
      expect(res.status).toBe(200);
      for (const widget of res.body.items as Row[]) {
        expect(Array.isArray(widget.notes)).toBe(true);
        expect(Array.isArray(widget.categories)).toBe(true);
      }
    });

    it('GET /api/widgets: a widget with no children receives empty notes AND categories arrays', async () => {
      const res = await request(app).get('/api/widgets');
      const gamma = res.body.items.find((w: Row) => w.id === 3) as Row;
      expect(gamma).toBeDefined();
      expect(gamma.notes).toEqual([]);
      expect(gamma.categories).toEqual([]);
    });

    it('GET /api/widgets vs GET /api/widgets/1: eager notes are byte-identical', async () => {
      const listRes = await request(app).get('/api/widgets');
      const singleRes = await request(app).get('/api/widgets/1');
      const alphaFromList = listRes.body.items.find((w: Row) => w.id === 1) as Row;
      expect(alphaFromList.notes).toEqual(singleRes.body.notes);
      expect(alphaFromList.categories).toEqual(singleRes.body.categories);
    });
  });
});
