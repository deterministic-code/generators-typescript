import request from 'supertest';
import express, { Application } from 'express';
import { createReadOnlyRouter } from '../createReadOnlyRouter';
import { PrimaryKey } from '../../repositories/PrimaryKey';
import type { RouteIdType } from '../routeParamUtils';
import { IEntityService } from '../../services/interfaces/IEntityService';
import { createMockCrudService } from '../../services/__tests__/mockCrudService';

interface TestEntity {
  id: number;
  uuid: string;
  name: string;
  created: string;
  updated: string;
}

function buildApp(
  mockService: jest.Mocked<IEntityService<TestEntity>>,
  { idType, primaryKeyParam = 'id' }: { idType: RouteIdType; primaryKeyParam?: string },
): Application {
  (mockService as unknown as { primaryKey: PrimaryKey }).primaryKey = new PrimaryKey(
    primaryKeyParam,
    idType,
  );
  const app = express();
  app.use(express.json());
  app.use(
    '/test-entities',
    createReadOnlyRouter({
      service: mockService,
      entityName: 'TestEntity',
    }),
  );
  return app;
}

const A_UUID = '00000000-0000-0000-0000-000000000007';

describe('createReadOnlyRouter', () => {
  let mockService: jest.Mocked<IEntityService<TestEntity>>;
  let app: Application;

  beforeEach(() => {
    mockService = createMockCrudService<TestEntity>('integer');
    app = buildApp(mockService, { idType: 'integer' });
  });

  describe('GET /test-entities', () => {
    it('returns 200 and list of entities', async () => {
      const entities: TestEntity[] = [
        {
          id: 1,
          uuid: 'u1',
          name: 'alpha',
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        },
      ];
      mockService.findAll.mockResolvedValue(entities);

      const res = await request(app).get('/test-entities');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: entities });
      expect(mockService.findAll).toHaveBeenCalledTimes(1);
    });

    it('returns 200 with empty array when none exist', async () => {
      mockService.findAll.mockResolvedValue([]);

      const res = await request(app).get('/test-entities');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [] });
    });
  });

  describe('GET /test-entities/:id', () => {
    it('returns 200 and the entity when found', async () => {
      const entity: TestEntity = {
        id: 1,
        uuid: 'u1',
        name: 'alpha',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      };
      mockService.findById.mockResolvedValue(entity);

      const res = await request(app).get('/test-entities/1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(entity);
      expect(mockService.findById).toHaveBeenCalledWith(1);
    });

    it('returns 404 when not found', async () => {
      mockService.findById.mockResolvedValue(null);

      const res = await request(app).get('/test-entities/999');

      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
    });

    it('returns 400 when id is not a valid number', async () => {
      const res = await request(app).get('/test-entities/abc');

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when id is zero', async () => {
      const res = await request(app).get('/test-entities/0');

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when id is negative', async () => {
      const res = await request(app).get('/test-entities/-1');

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });
  });

  describe('string primary key (idType: string, primaryKeyParam: name)', () => {
    function stringApp(): Application {
      return buildApp(mockService, { idType: 'string', primaryKeyParam: 'name' });
    }

    it('passes the raw string key to findById (does not coerce "7" to the number 7)', async () => {
      const entity: TestEntity = {
        id: 7,
        uuid: 'u7',
        name: 'seven',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      };
      mockService.findById.mockResolvedValue(entity);

      const res = await request(stringApp()).get('/test-entities/7');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(entity);
      expect(mockService.findById).toHaveBeenCalledWith('7');
    });

    it('accepts a non-numeric string key (404 on miss, never 400)', async () => {
      mockService.findById.mockResolvedValue(null);

      const res = await request(stringApp()).get('/test-entities/alpha-key');

      expect(res.status).toBe(404);
      expect(mockService.findById).toHaveBeenCalledWith('alpha-key');
    });
  });

  describe('uuid primary key (idType: uuid)', () => {
    function uuidApp(): Application {
      return buildApp(mockService, { idType: 'uuid' });
    }

    it('passes a valid uuid through to findById', async () => {
      const entity: TestEntity = {
        id: 1,
        uuid: A_UUID,
        name: 'alpha',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      };
      mockService.findById.mockResolvedValue(entity);

      const res = await request(uuidApp()).get(`/test-entities/${A_UUID}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(entity);
      expect(mockService.findById).toHaveBeenCalledWith(A_UUID);
    });

    it('rejects a non-uuid segment with 400 before touching the service', async () => {
      const res = await request(uuidApp()).get('/test-entities/7');

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(mockService.findById).not.toHaveBeenCalled();
    });
  });

  describe('write operations are not available', () => {
    it('POST returns 404', async () => {
      const res = await request(app).post('/test-entities').send({ name: 'new' });

      expect(res.status).toBe(404);
    });

    it('PUT returns 404', async () => {
      const res = await request(app).put('/test-entities/1').send({ name: 'updated' });

      expect(res.status).toBe(404);
    });

    it('DELETE returns 404', async () => {
      const res = await request(app).delete('/test-entities/1');

      expect(res.status).toBe(404);
    });
  });

  describe('error propagation', () => {
    it('calls next with error when service.findAll throws', async () => {
      mockService.findAll.mockRejectedValue(new Error('DB error'));

      const errorApp = express();
      errorApp.use(express.json());
      errorApp.use(
        '/test-entities',
        createReadOnlyRouter({
          service: mockService,
          entityName: 'TestEntity',
        }),
      );
      errorApp.use(
        (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
          res.status(500).json({ errors: [{ code: 'INTERNAL_ERROR', message: err.message }] });
        },
      );

      const res = await request(errorApp).get('/test-entities');

      expect(res.status).toBe(500);
      expect(res.body.errors[0].code).toBe('INTERNAL_ERROR');
    });

    it('calls next with error when service.find throws', async () => {
      mockService.findById.mockRejectedValue(new Error('DB error'));
      const errorApp = express();
      errorApp.use(express.json());
      errorApp.use(
        '/test-entities',
        createReadOnlyRouter({
          service: mockService,
          entityName: 'TestEntity',
        }),
      );
      errorApp.use(
        (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
          res.status(500).json({ errors: [{ code: 'INTERNAL_ERROR', message: err.message }] });
        },
      );

      const res = await request(errorApp).get('/test-entities/1');

      expect(res.status).toBe(500);
      expect(res.body.errors[0].code).toBe('INTERNAL_ERROR');
    });
  });
});
