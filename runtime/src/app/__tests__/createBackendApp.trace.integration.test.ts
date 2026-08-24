import { testPrimaryKeys } from '../../repositories/__tests__/testPrimaryKeys';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { connectDatabase } from '../connectDatabase';
import { SqliteCrudRepository } from '../../repositories/sqlite/SqliteCrudRepository';
import type { SqliteDatasource } from '../../repositories/sqlite/SqliteDatasource';
import {
  DataSourceConsoleLoggerMiddleware,
  MiddlewareLookup,
  ServiceConsoleLoggerMiddleware,
  traceRouteErrorMiddleware,
  traceRouteMiddleware,
} from '../../middleware';
import { wrapServicesWithTrace } from '../services/wrapServicesWithTrace';
import { createBackendApp, type CreateAppContext } from '../createBackendApp';
import type { DatabaseConnection } from '../../repositories/buildRepoForBackend';

interface Widget {
  id: number;
  uuid: string;
  name: string;
  created: string;
  updated: string;
}

const TRACE =
  /^\[[^\]]+\]-\[(route|service|datasource)\]\[(Start|Finish|Error)\]-\[([^\]]+)\](?:\s+(.*))?$/;

interface Captured {
  tier: 'route' | 'service' | 'datasource';
  phase: 'Start' | 'Finish' | 'Error';
  method: string;
  suffix?: string;
  raw: string;
}

function captureLines(spy: ReturnType<typeof vi.spyOn>): Captured[] {
  return spy.mock.calls
    .map((args) => String(args[0]))
    .map((raw) => ({ raw, m: TRACE.exec(raw) }))
    .filter((x): x is { raw: string; m: RegExpExecArray } => x.m !== null)
    .map((x) => ({
      tier: x.m[1] as Captured['tier'],
      phase: x.m[2] as Captured['phase'],
      method: x.m[3],
      suffix: x.m[4],
      raw: x.raw,
    }));
}

class WidgetService {
  constructor(private readonly repo: SqliteCrudRepository<Widget>) {}
  async findAll(): Promise<Widget[]> {
    return this.repo.findAll();
  }
  async findById(id: number): Promise<Widget | null> {
    return this.repo.find(id);
  }
}

describe('trace middleware e2e — all three tiers wired together', () => {
  let conn: Awaited<ReturnType<typeof connectDatabase>>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    conn = await connectDatabase({ backend: 'sqlite' });
    const ds = (conn as { datasource: SqliteDatasource }).datasource;
    ds.raw().exec(`
      CREATE TABLE widget (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL,
        name TEXT NOT NULL,
        created TEXT NOT NULL,
        updated TEXT NOT NULL
      );
      INSERT INTO widget (uuid, name, created, updated) VALUES
        ('w1', 'alpha', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ('w2', 'beta',  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    `);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await conn.close();
  });

  function buildApp(): express.Express {
    const ds = (conn as { datasource: SqliteDatasource }).datasource;
    const dsMiddlewares = [new DataSourceConsoleLoggerMiddleware()];
    const repo = new SqliteCrudRepository<Widget>(ds, 'widget', {
      middlewares: dsMiddlewares,
      entityName: 'test',
      primaryKeys: testPrimaryKeys('integer'),
    });
    const baseService = new WidgetService(repo);
    const service = wrapServicesWithTrace(
      baseService,
      'WidgetService',
      [new ServiceConsoleLoggerMiddleware()],
      ['findAll', 'findById'],
    );

    const app = express();
    app.use(traceRouteMiddleware);
    app.get('/api/widgets', async (_req, res, next) => {
      try {
        const items = await service.findAll();
        res.json({ items });
      } catch (err) {
        next(err);
      }
    });
    app.get('/api/widgets/:id', async (req, res, next) => {
      try {
        const item = await service.findById(Number(req.params.id));
        if (!item) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        res.json(item);
      } catch (err) {
        next(err);
      }
    });
    app.use(traceRouteErrorMiddleware);
    app.use((_req, res) => res.status(404).end());
    return app;
  }

  it('a GET /api/widgets request emits Start+Finish for route, service, and datasource', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/widgets').expect(200);
    expect(res.body.items).toHaveLength(2);

    const traced = captureLines(logSpy);
    const byTier = (tier: Captured['tier']) => traced.filter((t) => t.tier === tier);

    expect(byTier('route').map((t) => t.phase)).toEqual(['Start', 'Finish']);
    expect(byTier('route')[0].method).toBe('GET /api/widgets');
    expect(byTier('route')[1].suffix).toMatch(/^200 \d+(?:ms|μs)$/);

    expect(byTier('service').map((t) => t.phase)).toEqual(['Start', 'Finish']);
    expect(byTier('service')[0].method).toBe('WidgetService.findAll');

    const ds = byTier('datasource');
    expect(ds.length).toBeGreaterThanOrEqual(2);
    expect(ds[0].phase).toBe('Start');
    expect(ds[0].method).toMatch(/^SELECT\b/);
    expect(ds.find((t) => t.phase === 'Finish' && /^SELECT\b/.test(t.method))).toBeDefined();
  });

  it('Start phases nest correctly (route opens before service opens before datasource)', async () => {
    const app = buildApp();
    await request(app).get('/api/widgets').expect(200);

    const traced = captureLines(logSpy);
    const starts = traced.filter((t) => t.phase === 'Start').map((t) => t.tier);
    const routeIdx = starts.indexOf('route');
    const serviceIdx = starts.indexOf('service');
    const dsIdx = starts.indexOf('datasource');

    expect(routeIdx).toBeGreaterThanOrEqual(0);
    expect(serviceIdx).toBeGreaterThan(routeIdx);
    expect(dsIdx).toBeGreaterThan(serviceIdx);
  });

  it('Finish phases close in reverse order (datasource finishes before service before route)', async () => {
    const app = buildApp();
    await request(app).get('/api/widgets').expect(200);

    const traced = captureLines(logSpy);
    const finishes = traced.filter((t) => t.phase === 'Finish').map((t) => t.tier);
    const dsIdx = finishes.indexOf('datasource');
    const serviceIdx = finishes.indexOf('service');
    const routeIdx = finishes.indexOf('route');

    expect(dsIdx).toBeGreaterThanOrEqual(0);
    expect(serviceIdx).toBeGreaterThan(dsIdx);
    expect(routeIdx).toBeGreaterThan(serviceIdx);
  });

  it('suffix elapsed tracks the Start→Finish wall-clock span — the perf-clock suffix and the ms-truncated ISO stamps are two clocks, so only a rounding+CI-jitter-sized tolerance is sound', async () => {
    const app = buildApp();
    await request(app).get('/api/widgets').expect(200);

    const traced = captureLines(logSpy);
    const routeStart = traced.find((t) => t.tier === 'route' && t.phase === 'Start');
    const routeFinish = traced.find((t) => t.tier === 'route' && t.phase === 'Finish');
    expect(routeStart && routeFinish).toBeTruthy();

    const startIso = /^\[([^\]]+)\]/.exec(routeStart!.raw)![1];
    const finishIso = /^\[([^\]]+)\]/.exec(routeFinish!.raw)![1];
    const delta = Date.parse(finishIso) - Date.parse(startIso);
    const elapsedMatch = routeFinish!.suffix!.match(/(\d+)(ms|μs)/)!;
    const reportedMs =
      elapsedMatch[2] === 'μs' ? Number(elapsedMatch[1]) / 1000 : Number(elapsedMatch[1]);
    expect(reportedMs).toBeGreaterThan(0);
    expect(Math.abs(delta - reportedMs)).toBeLessThanOrEqual(50);
  });

  it('a 404 request emits Start+Finish for route but no service/datasource (route handler not reached)', async () => {
    const app = buildApp();
    await request(app).get('/api/unknown').expect(404);

    const traced = captureLines(logSpy);
    const tiers = new Set(traced.map((t) => t.tier));
    expect(tiers.has('route')).toBe(true);
    expect(tiers.has('service')).toBe(false);
    expect(tiers.has('datasource')).toBe(false);
  });

  it('a service-level error propagates as route Error + service Error (terminal latch held)', async () => {
    const ds = (conn as { datasource: SqliteDatasource }).datasource;
    const repo = new SqliteCrudRepository<Widget>(ds, 'widget', {
      middlewares: [new DataSourceConsoleLoggerMiddleware()],
      entityName: 'test',
      primaryKeys: testPrimaryKeys('integer'),
    });
    class FailingService {
      async detonate() {
        await repo.findAll();
        throw new Error('boom');
      }
    }
    const service = wrapServicesWithTrace(
      new FailingService(),
      'FailingService',
      [new ServiceConsoleLoggerMiddleware()],
      ['detonate'],
    );
    const app = express();
    app.use(traceRouteMiddleware);
    app.get('/api/boom', async (_req, _res, next) => {
      try {
        await service.detonate();
      } catch (err) {
        next(err);
      }
    });
    app.use(traceRouteErrorMiddleware);
    app.use(((_err, _req, res, _next) => {
      res.status(500).json({ error: 'server error' });
    }) as express.ErrorRequestHandler);

    await request(app).get('/api/boom').expect(500);

    const traced = captureLines(logSpy);
    const route = traced.filter((t) => t.tier === 'route');
    const serviceTraces = traced.filter((t) => t.tier === 'service');

    expect(route.map((t) => t.phase)).toEqual(['Start', 'Error']);
    expect(route[1].suffix).toMatch(/boom/);

    expect(serviceTraces.map((t) => t.phase)).toEqual(['Start', 'Error']);
    expect(serviceTraces[1].suffix).toMatch(/boom/);
  });
});

describe('createBackendApp integration — enableMiddleware flips the three tier middlewares on', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  async function setup() {
    const conn = await connectDatabase({ backend: 'sqlite' });
    const ds = (conn as { datasource: SqliteDatasource }).datasource;
    ds.raw().exec(`
      CREATE TABLE thing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL,
        name TEXT NOT NULL,
        created TEXT NOT NULL,
        updated TEXT NOT NULL
      );
      INSERT INTO thing (uuid, name, created, updated)
      VALUES ('t1','one','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
    `);
    return { conn, ds };
  }

  class ThingService {
    static readonly dependencies = [{ kind: 'repo' as const, name: 'thingRepo' }];
    constructor(public readonly repo: SqliteCrudRepository<Widget>) {}
    async handle(_req: express.Request, res: express.Response) {
      const all = await this.repo.findAll();
      res.json({ items: all });
    }
  }

  const baseOptions = {
    settingsConfig: { pluralizeTableNames: true },
    routeSpecs: [],
    crudSpecs: [],
    datasourceData: { types: [] },
    routesData: { combined_routes: [] },
    serviceSpecs: [
      {
        name: 'ThingService',
        module: '',
        args: [{ kind: 'repo' as const, name: 'thingRepo' }],
      },
    ],
    classRegistry: {
      ThingService: ThingService as unknown as new (...a: unknown[]) => unknown,
    },
    middlewareLookup: new MiddlewareLookup({}),
  };

  const makeThingRepo = (ds: SqliteDatasource, conn: DatabaseConnection) =>
    new SqliteCrudRepository<Widget>(ds, 'thing', {
      middlewares: conn.middlewares ?? [],
      entityName: 'test',
      primaryKeys: testPrimaryKeys('integer'),
    });

  const thingRepoHooks = (ds: SqliteDatasource, conn: DatabaseConnection) => ({
    onBeforeCreateApp: (ctx: CreateAppContext) => {
      ctx.repos.thingRepo = makeThingRepo(ds, conn);
    },
    onAfterCreateApp: (ctx: CreateAppContext) => {
      const svc = ctx.services.thingService as ThingService;
      ctx.app.get('/api/things', (req, res, next) => {
        svc.handle(req, res).catch(next);
      });
    },
  });

  it('createBackendApp + enableMiddleware:[traceRoute,traceService,traceDatasource] wires all three tiers', async () => {
    const { conn, ds } = await setup();

    const app = await createBackendApp(conn, {
      backendAppConfig: {
        middleware: [
          { name: 'traceRoute', type: 'route', enabled: false },
          { name: 'traceService', type: 'service', enabled: false },
          { name: 'traceDatasource', type: 'datasource', enabled: false },
        ],
        handlers: [],
      },
      enableMiddleware: ['traceRoute', 'traceService', 'traceDatasource'],
      ...baseOptions,
      ...thingRepoHooks(ds, conn),
    });

    await request(app).get('/api/things').expect(200);

    const traced = captureLines(logSpy);
    const tiers = new Set(traced.map((t) => t.tier));
    expect(tiers.has('route')).toBe(true);
    expect(tiers.has('service')).toBe(true);
    expect(tiers.has('datasource')).toBe(true);

    const serviceStart = traced.find((t) => t.tier === 'service' && t.phase === 'Start');
    expect(serviceStart?.method).toBe('ThingService.handle');

    await conn.close();
  });

  it('with no enableMiddleware passed, none of the three tiers fire (off by default)', async () => {
    const { conn, ds } = await setup();

    const app = await createBackendApp(conn, {
      backendAppConfig: {
        middleware: [
          { name: 'traceRoute', type: 'route', enabled: false },
          { name: 'traceService', type: 'service', enabled: false },
          { name: 'traceDatasource', type: 'datasource', enabled: false },
        ],
        handlers: [],
      },
      // enableMiddleware intentionally omitted
      ...baseOptions,
      ...thingRepoHooks(ds, conn),
    });

    await request(app).get('/api/things').expect(200);

    const traced = captureLines(logSpy);
    expect(traced).toEqual([]);

    await conn.close();
  });

  it('createBackendApp + enableMiddleware:[traceRoute] when backend-app.yaml omits trace entries auto-injects them and wires the error tier', async () => {
    const { conn, ds } = await setup();

    const app = await createBackendApp(conn, {
      backendAppConfig: {
        middleware: [],
        handlers: [{ name: 'ErrorHandlerMiddlewareService', enabled: true }],
      },
      enableMiddleware: ['traceRoute', 'traceService', 'traceDatasource'],
      ...baseOptions,
      onBeforeCreateApp: (ctx) => {
        ctx.repos.thingRepo = makeThingRepo(ds, conn);
      },
      onAfterCreateApp: (ctx) => {
        ctx.app.get('/api/boom', (_req, _res, next) => {
          next(new Error('boom'));
        });
      },
    });

    await request(app).get('/api/boom').expect(500);

    const traced = captureLines(logSpy);
    const route = traced.filter((t) => t.tier === 'route');
    const phases = route.map((t) => t.phase);
    expect(phases).toContain('Start');
    expect(phases).toContain('Error');
    const errLine = route.find((t) => t.phase === 'Error');
    expect(errLine?.suffix).toContain('boom');

    await conn.close();
  });
});
