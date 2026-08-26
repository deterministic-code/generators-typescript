import express, { Application } from 'express';
import request from 'supertest';
import { z } from 'zod';
import { IEntityService } from '../../services/interfaces/IEntityService';
import { mountCombinedRoutes } from '../mountCombinedRoutes';
import { PrimaryKey } from '../../repositories/PrimaryKey';
import type { DatasourceData, RoutesData } from '../iterateCombinedRoutes';
import { createMockCrudService as createMockService } from '../../services/__tests__/mockCrudService';

interface BaseRow {
  id: number;
  uuid: string;
  created: string;
  updated: string;
}

const datasourceData: DatasourceData = {
  types: [
    {
      app: {
        datasource_type: 'standard',
        fields: [{ name: { type: 'string' } }],
      },
    },
    {
      app_setting: {
        datasource_type: 'standard',
        fields: [
          { app_id: { type: 'number', references: 'app.id' } },
          { name: { type: 'string' } },
          { value: { type: 'string' } },
        ],
      },
    },
    {
      target_thing: {
        datasource_type: 'standard',
        fields: [{ label: { type: 'string' } }],
      },
    },
    {
      app_target_thing: {
        datasource_type: 'many-to-many',
        fields: [
          { app_id: { type: 'number', references: 'app.id' } },
          { target_thing_id: { type: 'number', references: 'target_thing.id' } },
        ],
      },
    },
  ],
};

const routesData: RoutesData = {
  combined_routes: [
    {
      app: {
        route: '/api/apps/{id}',
        combined_types: [
          { app_setting: { route: '/settings' } },
          {
            target_thing: {
              via: 'app_target_thing',
              target: 'target_thing',
              route: '/things',
            },
          },
        ],
      },
    },
  ],
};

interface AppRow extends BaseRow {
  name: string;
}
interface AppSettingRow extends BaseRow {
  app_id: number;
  name: string;
  value: string;
}
interface TargetThingRow extends BaseRow {
  label: string;
}
interface AppTargetThingRow extends BaseRow {
  app_id: number;
  target_thing_id: number;
}

function buildRepos(): {
  appService: jest.Mocked<IEntityService<AppRow>>;
  appSettingService: jest.Mocked<IEntityService<AppSettingRow>>;
  targetThingService: jest.Mocked<IEntityService<TargetThingRow>>;
  appTargetThingService: jest.Mocked<IEntityService<AppTargetThingRow>>;
} {
  return {
    appService: createMockService<AppRow>('integer'),
    appSettingService: createMockService<AppSettingRow>('integer'),
    targetThingService: createMockService<TargetThingRow>('integer'),
    appTargetThingService: createMockService<AppTargetThingRow>('integer'),
  };
}

const settingCreateSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
});

function buildApp(repos: ReturnType<typeof buildRepos>, idType: 'integer' | 'uuid'): Application {
  const pk = new PrimaryKey('id', idType);
  for (const svc of Object.values(repos)) {
    (svc as unknown as { primaryKey: PrimaryKey }).primaryKey = pk;
  }
  const app = express();
  app.use(express.json());
  mountCombinedRoutes(app, {
    repos: repos as unknown as Record<string, IEntityService<any, any>>,
    datasourceData,
    routesData,
    buildCreateSchema: () => settingCreateSchema,
    buildUpdateSchema: () => settingCreateSchema.partial(),
  });
  return app;
}

describe('mountCombinedRoutes', () => {
  const app1: AppRow = {
    id: 1,
    uuid: 'app1-uuid',
    name: 'A1',
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
  };

  describe('direct-fk children (settings)', () => {
    it('GET /api/apps/:appId/settings returns filtered settings', async () => {
      const repos = buildRepos();
      repos.appService.findById.mockResolvedValue(app1);
      repos.appSettingService.findAll.mockResolvedValue([
        {
          id: 1,
          uuid: 's1',
          app_id: 1,
          name: 'theme',
          value: 'dark',
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        },
        {
          id: 2,
          uuid: 's2',
          app_id: 2,
          name: 'theme',
          value: 'light',
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        },
      ]);

      const res = await request(buildApp(repos, 'integer')).get('/api/apps/1/settings');
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].name).toBe('theme');
    });

    it('POST /api/apps/:appId/settings creates a setting with FK injected', async () => {
      const repos = buildRepos();
      const created: AppSettingRow = {
        id: 9,
        uuid: 's9',
        app_id: 1,
        name: 'theme',
        value: 'dark',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      };
      repos.appSettingService.create.mockResolvedValue(created);

      const res = await request(buildApp(repos, 'integer'))
        .post('/api/apps/1/settings')
        .send({ name: 'theme', value: 'dark' });
      expect(res.status).toBe(201);
      expect(repos.appSettingService.create).toHaveBeenCalledWith({
        name: 'theme',
        value: 'dark',
        app_id: 1,
      });
    });
  });

  describe('m2m children (link via POST)', () => {
    const target1: TargetThingRow = {
      id: 10,
      uuid: 't10',
      label: 'first',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
    };

    it('GET /api/apps/:appId/things lists resolved targets via junction', async () => {
      const repos = buildRepos();
      repos.appService.findById.mockResolvedValue(app1);
      repos.appTargetThingService.findAll.mockResolvedValue([
        {
          id: 1,
          uuid: 'at1',
          app_id: 1,
          target_thing_id: 10,
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        },
      ]);
      repos.targetThingService.findAll.mockResolvedValue([target1]);

      const res = await request(buildApp(repos, 'integer')).get('/api/apps/1/things');
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([target1]);
    });

    it('GET /api/apps/:appId/things/:thingId returns the resolved target when linked', async () => {
      const repos = buildRepos();
      repos.appService.findById.mockResolvedValue(app1);
      repos.targetThingService.findById.mockResolvedValue(target1);
      repos.appTargetThingService.findAll.mockResolvedValue([
        {
          id: 1,
          uuid: 'at1',
          app_id: 1,
          target_thing_id: 10,
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        },
      ]);

      const res = await request(buildApp(repos, 'integer')).get('/api/apps/1/things/10');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(target1);
    });

    it('GET /api/apps/:appId/things/:thingId 404s when not linked', async () => {
      const repos = buildRepos();
      repos.appService.findById.mockResolvedValue(app1);
      repos.appTargetThingService.findAll.mockResolvedValue([]);

      const res = await request(buildApp(repos, 'integer')).get('/api/apps/1/things/10');
      expect(res.status).toBe(404);
    });

    it('POST /api/apps/:appId/things/:thingId links existing target (idempotent)', async () => {
      const repos = buildRepos();
      repos.appService.findById.mockResolvedValue(app1);
      repos.targetThingService.findById.mockResolvedValue(target1);
      repos.appTargetThingService.findAll.mockResolvedValue([]);
      repos.appTargetThingService.create.mockResolvedValue({
        id: 5,
        uuid: 'at5',
        app_id: 1,
        target_thing_id: 10,
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      });

      const res = await request(buildApp(repos, 'integer')).post('/api/apps/1/things/10');
      expect(res.status).toBe(201);
      expect(res.body).toEqual(target1);
      expect(repos.appTargetThingService.create).toHaveBeenCalledWith({
        app_id: 1,
        target_thing_id: 10,
      });
    });

    it('DELETE /api/apps/:appId/things/:thingId unlinks the target', async () => {
      const repos = buildRepos();
      repos.appService.findById.mockResolvedValue(app1);
      repos.appTargetThingService.findAll.mockResolvedValue([
        {
          id: 5,
          uuid: 'at5',
          app_id: 1,
          target_thing_id: 10,
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        },
      ]);
      repos.appTargetThingService.delete.mockResolvedValue(true);

      const res = await request(buildApp(repos, 'integer')).delete('/api/apps/1/things/10');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(repos.appTargetThingService.delete).toHaveBeenCalledWith(5);
    });

    it('does NOT register PUT /api/apps/:appId/things/:thingId (linkVerb is POST)', async () => {
      const repos = buildRepos();
      const res = await request(buildApp(repos, 'integer')).put('/api/apps/1/things/10');
      expect(res.status).toBe(404);
    });

    it('POST /api/apps/:appId/things accepts a uuid FK in the link body under a uuid id_type', async () => {
      const repos = buildRepos();
      const appUuid = '11111111-1111-1111-1111-111111111111';
      const thingUuid = '22222222-2222-2222-2222-222222222222';
      repos.appService.findById.mockResolvedValue(app1);
      repos.targetThingService.findById.mockResolvedValue(target1);
      repos.appTargetThingService.create.mockResolvedValue({
        id: 5,
        uuid: 'at5',
        app_id: appUuid as unknown as number,
        target_thing_id: thingUuid as unknown as number,
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      });

      const res = await request(buildApp(repos, 'uuid'))
        .post(`/api/apps/${appUuid}/things`)
        .send({ target_thing_id: thingUuid });

      expect(res.status).toBe(201);
      expect(repos.appTargetThingService.create).toHaveBeenCalledWith({
        app_id: appUuid,
        target_thing_id: thingUuid,
      });
    });
  });
});
