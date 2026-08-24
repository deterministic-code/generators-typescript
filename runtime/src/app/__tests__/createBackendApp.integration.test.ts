import { describe, expect, it } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { createBackendApp, type CreateAppContext } from '../createBackendApp';
import type { DatabaseConnection } from '../../repositories';
import { PrimaryKey } from '../../repositories/PrimaryKey';
import type { MiddlewareLookup } from '../../middleware';

class TerminalHandler {
  static readonly dependencies = [] as const;
  handle = (_req: Request, res: Response, _next: NextFunction): void => {
    res.status(404).json({ errors: [{ code: 'NOT_FOUND', message: 'Route not found' }] });
  };
}

const memoryConn = (): DatabaseConnection => ({
  type: 'memory',
  close: () => Promise.resolve(),
});

const noopLookup: MiddlewareLookup = {
  get: () => (_req: Request, _res: Response, next: NextFunction) => next(),
} as unknown as MiddlewareLookup;

const baseOptions = {
  backendAppConfig: {
    middleware: [{ name: 'noop', type: 'app' as const, enabled: true }],
    handlers: [{ name: 'TerminalHandler', enabled: true }],
  },
  routeSpecs: [],
  crudSpecs: [],
  datasourceData: { types: [] },
  routesData: { combined_routes: [] },
  serviceSpecs: [],
  classRegistry: {
    TerminalHandler: TerminalHandler as unknown as new (...a: unknown[]) => unknown,
  },
  middlewareLookup: noopLookup,
  settingsConfig: { pluralizeTableNames: true },
};

describe('createBackendApp hook ordering', () => {
  it('invokes onBeforeCreateApp before services are resolved and onAfterCreateApp after', async () => {
    const order: string[] = [];

    await createBackendApp(memoryConn(), {
      ...baseOptions,
      onBeforeCreateApp: (ctx: CreateAppContext) => {
        order.push('before');
        expect(Object.keys(ctx.services)).toEqual([]);
      },
      onAfterCreateApp: (ctx: CreateAppContext) => {
        order.push('after');
        expect(ctx.services.terminalHandler).toBeDefined();
      },
    });

    expect(order).toEqual(['before', 'after']);
  });

  it('awaits async hooks', async () => {
    const order: string[] = [];

    await createBackendApp(memoryConn(), {
      ...baseOptions,
      onBeforeCreateApp: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('before');
      },
      onAfterCreateApp: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('after');
      },
    });

    expect(order).toEqual(['before', 'after']);
  });
});

describe('createBackendApp hook capabilities', () => {
  it('repo wraps from onBeforeCreateApp are visible to service resolution', async () => {
    class WrappedRepo {
      readonly entityName = 'user';
      readonly primaryKey = new PrimaryKey('id', 'integer');
      constructor(public readonly inner: unknown) {}
    }
    class Consumer {
      constructor(public readonly userRepo: unknown) {}
    }

    const captured: { consumer?: Consumer } = {};

    await createBackendApp(memoryConn(), {
      ...baseOptions,
      crudSpecs: [
        {
          entityName: 'user',
          pathSegment: 'users',
          primaryKeyColumn: 'id',
          primaryKeyIdType: 'integer',
          columns: [],
        },
      ],
      serviceSpecs: [{ name: 'Consumer', args: [{ kind: 'repo', name: 'userService' }] }],
      classRegistry: {
        ...baseOptions.classRegistry,
        Consumer: Consumer as unknown as new (...a: unknown[]) => unknown,
      },
      onBeforeCreateApp: (ctx) => {
        const raw = ctx.repos.userService;
        ctx.repos.userService = new WrappedRepo(raw);
      },
      onAfterCreateApp: (ctx) => {
        captured.consumer = ctx.services.consumer as Consumer;
      },
    });

    expect(captured.consumer).toBeInstanceOf(Consumer);
    expect(captured.consumer?.userRepo).toBeInstanceOf(WrappedRepo);
  });

  it('onAfterCreateApp receives the app and can mount custom middleware on it', async () => {
    let observedApp: express.Express | undefined;
    let routerRegistered = false;

    const app = await createBackendApp(memoryConn(), {
      ...baseOptions,
      onAfterCreateApp: (ctx) => {
        observedApp = ctx.app;
        const router = express.Router();
        router.get('/api/custom', (_req, res) => res.json({ ok: true }));
        ctx.app.use(router);
        routerRegistered = true;
      },
    });

    expect(observedApp).toBe(app);
    expect(routerRegistered).toBe(true);
  });

  it('populates the context with config, repos, services, and specs', async () => {
    let observed: CreateAppContext | undefined;

    await createBackendApp(memoryConn(), {
      ...baseOptions,
      config: { jwtSecret: 'abc' },
      crudSpecs: [
        {
          entityName: 'item',
          pathSegment: 'items',
          primaryKeyColumn: 'id',
          primaryKeyIdType: 'integer',
          columns: [],
        },
      ],
      onAfterCreateApp: (ctx) => {
        observed = ctx;
      },
    });

    expect(observed?.config).toEqual({ jwtSecret: 'abc' });
    expect(observed?.repos.itemService).toBeDefined();
    expect(observed?.services.terminalHandler).toBeDefined();
    expect(observed?.crudSpecs).toHaveLength(1);
  });
});

describe('createBackendApp validation', () => {
  it('throws when a generic route references a service not in the resolved set', async () => {
    await expect(
      createBackendApp(memoryConn(), {
        ...baseOptions,
        routeSpecs: [
          {
            routeName: 'g',
            path: '/api/g',
            method: 'GET',
            service: 'Missing',
            serviceMethod: 'x',
          },
        ],
      }),
    ).rejects.toThrow(/service "Missing"/);
  });

  it('throws when a generic route references a method not on the service', async () => {
    class Svc {
      static readonly dependencies = [] as const;
    }
    await expect(
      createBackendApp(memoryConn(), {
        ...baseOptions,
        serviceSpecs: [{ name: 'Svc', args: [] }],
        classRegistry: {
          ...baseOptions.classRegistry,
          Svc: Svc as unknown as new (...a: unknown[]) => unknown,
        },
        routeSpecs: [
          {
            routeName: 'g',
            path: '/api/g',
            method: 'GET',
            service: 'Svc',
            serviceMethod: 'missingMethod',
          },
        ],
      }),
    ).rejects.toThrow(/missingMethod.*is not a function/);
  });

  it('throws when a handler in backend-app.yaml is not a resolved service', async () => {
    await expect(
      createBackendApp(memoryConn(), {
        ...baseOptions,
        backendAppConfig: {
          middleware: [{ name: 'noop', type: 'app' as const, enabled: true }],
          handlers: [{ name: 'NotResolved', enabled: true }],
        },
      }),
    ).rejects.toThrow(/handler "NotResolved"/);
  });

  it('mounts a library-default GET /api/health when routes.yaml omits it', async () => {
    const app = await createBackendApp(memoryConn(), {
      ...baseOptions,
      backendAppConfig: {
        middleware: [{ name: 'noop', type: 'app' as const, enabled: true }],
        handlers: [{ name: 'TerminalHandler', enabled: true }],
      },
    });
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('library-default /api/health is suppressed when a soft-skipped (service-only) entry declares the path', async () => {
    // service-present + serviceMethod-absent soft-skips in parseGenericRouteSpecs (hand-wired), so the library default /api/health must NOT mask the declaration; createBackendApp aliases routesData into routesDoc which hasDeclaredHealthRoute reads.
    const routesDoc = {
      combined_routes: [],
      routes: [
        {
          health: {
            path: '/api/health',
            method: 'GET',
            service: 'ExternallyWiredService',
          },
        },
      ],
    };
    const app = await createBackendApp(memoryConn(), {
      ...baseOptions,
      routesData: routesDoc as unknown as (typeof baseOptions)['routesData'],
    });
    const res = await request(app).get('/api/health');
    // No real handler for this hand-wired entry → terminal 404 fires; the library default's 200 must NOT win.
    expect(res.body).not.toEqual({ status: 'ok' });
    expect(res.status).toBe(404);
  });

  it('mounts /api/health from routes.yaml', async () => {
    class HealthCheckService {
      static readonly dependencies = [] as const;
      check = () => ({ status: 'custom' });
    }
    const app = await createBackendApp(memoryConn(), {
      ...baseOptions,
      routeSpecs: [
        {
          routeName: 'health',
          path: '/api/health',
          method: 'GET',
          service: 'HealthCheckService',
          serviceMethod: 'check',
        },
      ],
      serviceSpecs: [{ name: 'HealthCheckService', args: [] }],
      classRegistry: {
        ...baseOptions.classRegistry,
        HealthCheckService: HealthCheckService as unknown as new (...a: unknown[]) => unknown,
      },
    });
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'custom' });
  });

  it('mounts a built-in 404 when handlers lists NotFoundMiddlewareService and no class is registered', async () => {
    const app = await createBackendApp(memoryConn(), {
      ...baseOptions,
      backendAppConfig: {
        middleware: [{ name: 'noop', type: 'app' as const, enabled: true }],
        handlers: [{ name: 'NotFoundMiddlewareService', enabled: true }],
      },
      classRegistry: {},
      serviceSpecs: [],
    });
    const res = await request(app).get('/api/unknown-path');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      errors: [{ code: 'NOT_FOUND', message: 'Route not found' }],
    });
  });

  it('user-supplied NotFoundMiddlewareService overrides the built-in', async () => {
    class NotFoundMiddlewareService {
      static readonly dependencies = [] as const;
      handle = (_req: Request, res: Response, _next: NextFunction): void => {
        res.status(404).json({ marker: 'user-supplied' });
      };
    }
    const app = await createBackendApp(memoryConn(), {
      ...baseOptions,
      backendAppConfig: {
        middleware: [{ name: 'noop', type: 'app' as const, enabled: true }],
        handlers: [{ name: 'NotFoundMiddlewareService', enabled: true }],
      },
      serviceSpecs: [{ name: 'NotFoundMiddlewareService', args: [] }],
      classRegistry: {
        NotFoundMiddlewareService: NotFoundMiddlewareService as unknown as new (
          ...a: unknown[]
        ) => unknown,
      },
    });
    const res = await request(app).get('/api/unknown-path');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ marker: 'user-supplied' });
  });

  it('mounts the built-in ErrorHandlerMiddlewareService at the tail when declared', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    class BoomService {
      static readonly dependencies = [] as const;
      async go(): Promise<unknown> {
        throw new Error('boom');
      }
    }
    const app = await createBackendApp(memoryConn(), {
      ...baseOptions,
      backendAppConfig: {
        middleware: [{ name: 'noop', type: 'app' as const, enabled: true }],
        handlers: [{ name: 'ErrorHandlerMiddlewareService', enabled: true }],
      },
      routeSpecs: [
        {
          routeName: 'boom',
          path: '/api/boom',
          method: 'GET',
          service: 'BoomService',
          serviceMethod: 'go',
        },
      ],
      serviceSpecs: [{ name: 'BoomService', args: [] }],
      classRegistry: {
        BoomService: BoomService as unknown as new (...a: unknown[]) => unknown,
      },
    });
    const res = await request(app).get('/api/boom');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body).toMatchObject({ errors: expect.any(Array) });
    errSpy.mockRestore();
  });

  it('handlers with enabled: false are skipped (not mounted)', async () => {
    const app = await createBackendApp(memoryConn(), {
      ...baseOptions,
      backendAppConfig: {
        middleware: [{ name: 'noop', type: 'app' as const, enabled: true }],
        handlers: [
          { name: 'NotFoundMiddlewareService', enabled: false },
          // Also test the framework still works with no live handlers.
        ],
      },
      classRegistry: {},
      serviceSpecs: [],
    });
    // With NotFoundMiddlewareService disabled, Express's default 404 takes over (HTML body) vs the framework built-in's JSON `{errors: [...]}`.
    const res = await request(app).get('/api/unknown-path');
    expect(res.status).toBe(404);
    expect(res.body).not.toMatchObject({ errors: expect.any(Array) });
  });

  it('mounts a routes.yaml entry at its declared path (no double-prefix)', async () => {
    class HealthCheckService {
      static readonly dependencies = [] as const;
      check = () => ({ status: 'ok' });
    }
    const app = await createBackendApp(memoryConn(), {
      ...baseOptions,
      routeSpecs: [
        {
          routeName: 'health',
          path: '/api/health',
          method: 'GET',
          service: 'HealthCheckService',
          serviceMethod: 'check',
        },
      ],
      serviceSpecs: [{ name: 'HealthCheckService', args: [] }],
      classRegistry: {
        ...baseOptions.classRegistry,
        HealthCheckService: HealthCheckService as unknown as new (...a: unknown[]) => unknown,
      },
    });

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });

    const wrong = await request(app).get('/api/health/api/health');
    expect(wrong.status).toBe(404);
  });

  it('throws when a handler service is missing the handle method', async () => {
    class WrongShape {
      static readonly dependencies = [] as const;
    }
    await expect(
      createBackendApp(memoryConn(), {
        ...baseOptions,
        backendAppConfig: {
          middleware: [{ name: 'noop', type: 'app' as const, enabled: true }],
          handlers: [{ name: 'WrongShape', enabled: true }],
        },
        classRegistry: {
          WrongShape: WrongShape as unknown as new (...a: unknown[]) => unknown,
        },
      }),
    ).rejects.toThrow(/WrongShape\.handle is not a function/);
  });
});

describe('createBackendApp middleware gating', () => {
  function makeCountingLookup(): {
    lookup: MiddlewareLookup;
    hits: Record<string, string[]>;
  } {
    const hits: Record<string, string[]> = {};
    const lookup = {
      get: (name: string) => (req: Request, _res: Response, next: NextFunction) => {
        (hits[name] ??= []).push(req.path);
        next();
      },
    } as unknown as MiddlewareLookup;
    return { lookup, hits };
  }

  function makeServiceFixtures() {
    class HealthCheckService {
      static readonly dependencies = [] as const;
      check = () => ({ status: 'ok' });
    }
    class EchoService {
      static readonly dependencies = [] as const;
      pong = () => ({ pong: true });
    }
    return {
      classRegistry: {
        ...baseOptions.classRegistry,
        HealthCheckService: HealthCheckService as unknown as new (...a: unknown[]) => unknown,
        EchoService: EchoService as unknown as new (...a: unknown[]) => unknown,
      },
      serviceSpecs: [
        { name: 'HealthCheckService', args: [] },
        { name: 'EchoService', args: [] },
      ],
      routeSpecs: [
        {
          routeName: 'health',
          path: '/api/health',
          method: 'GET' as const,
          service: 'HealthCheckService',
          serviceMethod: 'check',
        },
        {
          routeName: 'echo',
          path: '/api/echo',
          method: 'GET' as const,
          service: 'EchoService',
          serviceMethod: 'pong',
        },
      ],
    };
  }

  it('skips middleware whose entry has enabled: false', async () => {
    const { lookup, hits } = makeCountingLookup();
    const fixtures = makeServiceFixtures();

    const app = await createBackendApp(memoryConn(), {
      ...baseOptions,
      backendAppConfig: {
        middleware: [
          { name: 'tracker', type: 'app' as const, enabled: true },
          { name: 'disabled', type: 'app' as const, enabled: false },
        ],
        handlers: [{ name: 'TerminalHandler', enabled: true }],
      },
      ...fixtures,
      middlewareLookup: lookup,
    });

    await request(app).get('/api/health');

    expect(hits.tracker).toEqual(['/api/health']);
    expect(hits.disabled).toBeUndefined();
  });

  it('apply_routes scopes a global middleware to listed prefixes only', async () => {
    const { lookup, hits } = makeCountingLookup();
    const fixtures = makeServiceFixtures();

    const app = await createBackendApp(memoryConn(), {
      ...baseOptions,
      backendAppConfig: {
        middleware: [
          { name: 'guard', type: 'app' as const, enabled: true, apply_routes: ['/api/echo'] },
        ],
        handlers: [{ name: 'TerminalHandler', enabled: true }],
      },
      ...fixtures,
      middlewareLookup: lookup,
    });

    await request(app).get('/api/echo');
    await request(app).get('/api/health');

    expect(hits.guard).toEqual(['/api/echo']);
  });

  it('apply_routes matches subpaths of a listed prefix', async () => {
    const { lookup, hits } = makeCountingLookup();

    const app = await createBackendApp(memoryConn(), {
      ...baseOptions,
      backendAppConfig: {
        middleware: [
          { name: 'guard', type: 'app' as const, enabled: true, apply_routes: ['/api/echo'] },
        ],
        handlers: [{ name: 'TerminalHandler', enabled: true }],
      },
      middlewareLookup: lookup,
    });

    await request(app).get('/api/echo/sub');

    expect(hits.guard).toEqual(['/api/echo/sub']);
  });

  it('deny_routes runs everywhere except listed prefixes', async () => {
    const { lookup, hits } = makeCountingLookup();
    const fixtures = makeServiceFixtures();

    const app = await createBackendApp(memoryConn(), {
      ...baseOptions,
      backendAppConfig: {
        middleware: [
          { name: 'guard', type: 'app' as const, enabled: true, deny_routes: ['/api/health'] },
        ],
        handlers: [{ name: 'TerminalHandler', enabled: true }],
      },
      ...fixtures,
      middlewareLookup: lookup,
    });

    await request(app).get('/api/echo');
    await request(app).get('/api/health');

    expect(hits.guard).toEqual(['/api/echo']);
  });
});

async function datasourceLoggerMiddlewareWired(enabled: boolean): Promise<boolean> {
  const conn: DatabaseConnection = {
    type: 'memory',
    close: () => Promise.resolve(),
  };
  let middlewareWired = false;
  await createBackendApp(conn, {
    ...baseOptions,
    backendAppConfig: {
      middleware: [{ name: 'dataSourceConsoleLogger', type: 'datasource' as const, enabled }],
      handlers: [{ name: 'TerminalHandler', enabled: true }],
    },
    crudSpecs: [
      {
        entityName: 'user',
        pathSegment: 'users',
        primaryKeyColumn: 'id',
        primaryKeyIdType: 'integer',
        columns: [],
      },
    ],
    onAfterCreateApp: (ctx) => {
      middlewareWired = (ctx.conn.middlewares ?? []).length > 0;
    },
  });
  return middlewareWired;
}

describe('createBackendApp datasource middleware', () => {
  it('datasource middleware is constructed and reaches repos', async () => {
    const logLines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logLines.push(String(args[0]));

    try {
      expect(await datasourceLoggerMiddlewareWired(true)).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  it('datasource entries do not crash the express mount loop', async () => {
    const conn: DatabaseConnection = {
      type: 'memory',
      close: () => Promise.resolve(),
    };

    const app = await createBackendApp(conn, {
      ...baseOptions,
      backendAppConfig: {
        middleware: [
          { name: 'dataSourceConsoleLogger', type: 'datasource' as const, enabled: true },
        ],
        handlers: [{ name: 'TerminalHandler', enabled: true }],
      },
    });

    expect(app).toBeDefined();
  });

  it('unknown datasource middleware name throws a clear error', async () => {
    const conn: DatabaseConnection = {
      type: 'memory',
      close: () => Promise.resolve(),
    };

    await expect(
      createBackendApp(conn, {
        ...baseOptions,
        backendAppConfig: {
          middleware: [{ name: 'noSuchThing', type: 'datasource' as const, enabled: true }],
          handlers: [{ name: 'TerminalHandler', enabled: true }],
        },
      }),
    ).rejects.toThrow(/Unknown datasource middleware: noSuchThing/);
  });

  it('disabled datasource middleware is skipped', async () => {
    expect(await datasourceLoggerMiddlewareWired(false)).toBe(false);
  });
});
