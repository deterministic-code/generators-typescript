import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { createBackendApp } from '../createBackendApp';
import { connectDatabase } from '../connectDatabase';
import {
  DataSourceConsoleLoggerMiddleware,
  ServiceConsoleLoggerMiddleware,
  type DataSourceMiddlewareFactory,
  type IDataSourceMiddleware,
  type IServiceMiddleware,
  type ServiceMiddlewareFactory,
} from '../../middleware';

class TerminalHandler {
  static readonly dependencies = [] as const;
  handle = (_req: Request, res: Response, _next: NextFunction): void => {
    res.status(404).json({ errors: [{ code: 'NOT_FOUND', message: 'Route not found' }] });
  };
}

class GreeterService {
  static readonly dependencies = [] as const;
  async greet(): Promise<{ hello: string }> {
    return { hello: 'world' };
  }
}

const BASE_APP_OPTIONS = {
  settingsConfig: { pluralizeTableNames: true },
  routeSpecs: [],
  crudSpecs: [],
  datasourceData: { types: [] },
  routesData: { combined_routes: [] },
};

describe('createBackendApp middleware factories integration', () => {
  test('yaml-declared middleware order resolves built-ins and factories in interleaved sequence', async () => {
    const order: string[] = [];

    const datasourceImpl: IDataSourceMiddleware = {
      beforeQuery: vi.fn(),
      afterQuery: vi.fn(),
    };
    const serviceImpl: IServiceMiddleware = {
      beforeCall: vi.fn((_service, method) => {
        order.push(`myCustomServiceAudit.beforeCall:${method}`);
      }),
      afterCall: vi.fn(),
    };

    const datasourceFactory: DataSourceMiddlewareFactory = vi.fn(() => datasourceImpl);
    const serviceFactory: ServiceMiddlewareFactory = vi.fn(() => serviceImpl);

    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (/\[service\]\[Start\]-\[GreeterService\.greet\]/.test(line)) {
        order.push('traceService.beforeCall:greet');
      }
    });

    const conn = await connectDatabase({ backend: 'memory' });
    try {
      const app = await createBackendApp(conn, {
        backendAppConfig: {
          middleware: [
            { name: 'traceDatasource', type: 'datasource', enabled: true },
            { name: 'myCustomQueryAudit', type: 'datasource', enabled: true },
            { name: 'traceService', type: 'service', enabled: true },
            { name: 'myCustomServiceAudit', type: 'service', enabled: true },
          ],
          handlers: [{ name: 'TerminalHandler', enabled: true }],
        },
        ...BASE_APP_OPTIONS,
        serviceSpecs: [
          { name: 'GreeterService', args: [] },
          { name: 'TerminalHandler', args: [] },
        ],
        classRegistry: {
          GreeterService: GreeterService as unknown as new (...a: unknown[]) => unknown,
          TerminalHandler: TerminalHandler as unknown as new (...a: unknown[]) => unknown,
        },
        middlewareFactories: {
          service: { myCustomServiceAudit: serviceFactory },
          datasource: { myCustomQueryAudit: datasourceFactory },
        },
        onAfterCreateApp: (ctx) => {
          const svc = ctx.services.greeterService as GreeterService;
          ctx.app.get('/api/greet', (_req, res, next) => {
            svc
              .greet()
              .then((body) => res.json(body))
              .catch(next);
          });
        },
      });

      // failure-mode: conn.middlewares must keep declared order (built-in first, factory result second); filtering by built-in name first reorders silently while the count stays 2.
      expect(conn.middlewares).toHaveLength(2);
      expect(conn.middlewares?.[0]).toBeInstanceOf(DataSourceConsoleLoggerMiddleware);
      expect(conn.middlewares?.[1]).toBe(datasourceImpl);

      // failure-mode: each factory must be called exactly once at construction with resolved deps; >1 means per-request reconstruction, 0 means the factory branch never fired.
      expect(datasourceFactory).toHaveBeenCalledTimes(1);
      expect(datasourceFactory).toHaveBeenCalledWith({});
      expect(serviceFactory).toHaveBeenCalledTimes(1);
      expect(serviceFactory).toHaveBeenCalledWith({});

      const res = await request(app).get('/api/greet').expect(200);
      expect(res.body).toEqual({ hello: 'world' });

      // failure-mode: service-tier chain must fire in declared order [traceService, myCustomServiceAudit]; if iterateMiddlewareForTier loses declared order the audit fires first and this array reverses.
      const greetOrder = order.filter((s) => s.endsWith(':greet'));
      expect(greetOrder).toEqual([
        'traceService.beforeCall:greet',
        'myCustomServiceAudit.beforeCall:greet',
      ]);

      expect(serviceImpl.beforeCall).toHaveBeenCalledWith('GreeterService', 'greet', []);
    } finally {
      logSpy.mockRestore();
      await conn.close();
    }
  });

  test('explicit serviceMiddlewareLookup / datasourceMiddlewareLookup options bypass factories', async () => {
    const customDs = new DataSourceConsoleLoggerMiddleware();
    const customSvc = new ServiceConsoleLoggerMiddleware();
    const datasourceFactory: DataSourceMiddlewareFactory = vi.fn();
    const serviceFactory: ServiceMiddlewareFactory = vi.fn();

    const conn = await connectDatabase({ backend: 'memory' });
    try {
      await createBackendApp(conn, {
        backendAppConfig: {
          middleware: [
            { name: 'onlyDs', type: 'datasource', enabled: true },
            { name: 'onlySvc', type: 'service', enabled: true },
          ],
          handlers: [{ name: 'TerminalHandler', enabled: true }],
        },
        ...BASE_APP_OPTIONS,
        serviceSpecs: [{ name: 'TerminalHandler', args: [] }],
        classRegistry: {
          TerminalHandler: TerminalHandler as unknown as new (...a: unknown[]) => unknown,
        },
        // why: an explicit lookup must short-circuit the factories option so consumers can replace the resolver without forking createBackendApp.
        datasourceMiddlewareLookup: {
          get: (name: string) => {
            if (name === 'onlyDs') return customDs;
            throw new Error(`unexpected name ${name}`);
          },
        } as unknown as import('../../middleware').DataSourceMiddlewareLookup,
        serviceMiddlewareLookup: {
          get: (name: string) => {
            if (name === 'onlySvc') return customSvc;
            throw new Error(`unexpected name ${name}`);
          },
        } as unknown as import('../../middleware').ServiceMiddlewareLookup,
        middlewareFactories: {
          datasource: { onlyDs: datasourceFactory },
          service: { onlySvc: serviceFactory },
        },
      });

      expect(conn.middlewares).toEqual([customDs]);
      expect(datasourceFactory).not.toHaveBeenCalled();
      expect(serviceFactory).not.toHaveBeenCalled();
    } finally {
      await conn.close();
    }
  });
});
