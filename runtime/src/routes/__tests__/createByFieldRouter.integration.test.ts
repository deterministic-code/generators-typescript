import request from 'supertest';
import express, { Application, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { createByFieldRouter, ByFieldRouterOptions } from '../createByFieldRouter';
import { IEntityService } from '../../services/interfaces/IEntityService';
import { createMockCrudService } from '../../services/__tests__/mockCrudService';

interface NotificationRow {
  id: number;
  uuid: string;
  created: string;
  updated: string;
  notification_type: string;
  status: string;
}

type MockService = jest.Mocked<IEntityService<NotificationRow>>;

function buildApp(
  service: MockService,
  opts: Omit<ByFieldRouterOptions<NotificationRow>, 'service'>,
): Application {
  const app = express();
  app.use(express.json());
  app.use('/notifications', createByFieldRouter({ service, ...opts }));
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ errors: [{ code: 'INTERNAL_ERROR', message: err.message }] });
  });
  return app;
}

const ROW: NotificationRow = {
  id: 1,
  uuid: 'u1',
  created: '2026-01-01T00:00:00Z',
  updated: '2026-01-01T00:00:00Z',
  notification_type: 'EMAIL',
  status: 'sent',
};

describe('createByFieldRouter', () => {
  let service: MockService;

  beforeEach(() => {
    service = createMockCrudService<NotificationRow>('integer');
  });

  describe('unique GET (snake_case field mapped to a camelCase param)', () => {
    function app(): Application {
      return buildApp(service, {
        field: 'notification_type',
        unique: true,
        methods: ['GET'],
        entityName: 'Notification',
      });
    }

    it('returns 200 and the single row via the kebab-cased path', async () => {
      service.findBy.mockResolvedValue([ROW]);

      const res = await request(app()).get('/notifications/notification-type/EMAIL');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(ROW);
      expect(service.findBy).toHaveBeenCalledWith([{ name: 'notification_type', value: 'EMAIL' }]);
    });

    it('returns 404 when no row matches', async () => {
      service.findBy.mockResolvedValue([]);

      const res = await request(app()).get('/notifications/notification-type/SMS');

      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
    });

    it('returns 409 when more than one row matches', async () => {
      service.findBy.mockResolvedValue([ROW, { ...ROW, id: 2 }]);

      const res = await request(app()).get('/notifications/notification-type/EMAIL');

      expect(res.status).toBe(409);
      expect(res.body.errors[0].code).toBe('CONFLICT');
    });

    it('forwards a service error to the error middleware', async () => {
      service.findBy.mockRejectedValue(new Error('DB down'));

      const res = await request(app()).get('/notifications/notification-type/EMAIL');

      expect(res.status).toBe(500);
      expect(res.body.errors[0].message).toBe('DB down');
    });
  });

  describe('collection GET (unique: false)', () => {
    it('returns 200 and the items envelope', async () => {
      service.findBy.mockResolvedValue([ROW, { ...ROW, id: 2 }]);

      const res = await request(
        buildApp(service, {
          field: 'status',
          unique: false,
          methods: ['GET'],
          entityName: 'Notification',
        }),
      ).get('/notifications/status/sent');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [ROW, { ...ROW, id: 2 }] });
    });
  });

  describe('unique PUT with an update schema', () => {
    const updateSchema = z.object({ status: z.string() });

    function app(): Application {
      return buildApp(service, {
        field: 'notification_type',
        unique: true,
        methods: ['PUT'],
        entityName: 'Notification',
        updateSchema,
      });
    }

    it('returns 200 and the refreshed row after a single update', async () => {
      service.updateBy.mockResolvedValue(1);
      service.findBy.mockResolvedValue([{ ...ROW, status: 'read' }]);

      const res = await request(app())
        .put('/notifications/notification-type/EMAIL')
        .send({ status: 'read' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('read');
      expect(service.updateBy).toHaveBeenCalledWith(
        [{ name: 'notification_type', value: 'EMAIL' }],
        { status: 'read' },
      );
    });

    it('returns 200 with a null body when the refresh find returns nothing', async () => {
      service.updateBy.mockResolvedValue(1);
      service.findBy.mockResolvedValue([]);

      const res = await request(app())
        .put('/notifications/notification-type/EMAIL')
        .send({ status: 'read' });

      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });

    it('returns 404 when the update matched no rows', async () => {
      service.updateBy.mockResolvedValue(0);

      const res = await request(app())
        .put('/notifications/notification-type/SMS')
        .send({ status: 'read' });

      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
    });

    it('returns 409 when the update matched more than one row', async () => {
      service.updateBy.mockResolvedValue(2);

      const res = await request(app())
        .put('/notifications/notification-type/EMAIL')
        .send({ status: 'read' });

      expect(res.status).toBe(409);
      expect(res.body.errors[0].code).toBe('CONFLICT');
    });

    it('returns 400 when the body fails schema validation', async () => {
      const res = await request(app())
        .put('/notifications/notification-type/EMAIL')
        .send({ status: 42 });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(service.updateBy).not.toHaveBeenCalled();
    });

    it('forwards a non-zod service error to the error middleware', async () => {
      service.updateBy.mockRejectedValue(new Error('write failed'));

      const res = await request(app())
        .put('/notifications/notification-type/EMAIL')
        .send({ status: 'read' });

      expect(res.status).toBe(500);
      expect(res.body.errors[0].message).toBe('write failed');
    });
  });

  describe('PUT without a schema (raw body)', () => {
    it('collection PUT returns the affected count', async () => {
      service.updateBy.mockResolvedValue(3);

      const res = await request(
        buildApp(service, {
          field: 'status',
          unique: false,
          methods: ['PUT'],
          entityName: 'Notification',
        }),
      )
        .put('/notifications/status/sent')
        .send({ status: 'archived' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 3 });
      expect(service.updateBy).toHaveBeenCalledWith([{ name: 'status', value: 'sent' }], {
        status: 'archived',
      });
    });
  });

  describe('unique DELETE', () => {
    function app(): Application {
      return buildApp(service, {
        field: 'notification_type',
        unique: true,
        methods: ['DELETE'],
        entityName: 'Notification',
      });
    }

    it('returns 204 after deleting a single row', async () => {
      service.deleteBy.mockResolvedValue(1);

      const res = await request(app()).delete('/notifications/notification-type/EMAIL');

      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
    });

    it('returns 404 when the delete matched no rows', async () => {
      service.deleteBy.mockResolvedValue(0);

      const res = await request(app()).delete('/notifications/notification-type/SMS');

      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
    });

    it('returns 409 when the delete matched more than one row', async () => {
      service.deleteBy.mockResolvedValue(2);

      const res = await request(app()).delete('/notifications/notification-type/EMAIL');

      expect(res.status).toBe(409);
      expect(res.body.errors[0].code).toBe('CONFLICT');
    });

    it('forwards a service error to the error middleware', async () => {
      service.deleteBy.mockRejectedValue(new Error('delete failed'));

      const res = await request(app()).delete('/notifications/notification-type/EMAIL');

      expect(res.status).toBe(500);
      expect(res.body.errors[0].message).toBe('delete failed');
    });
  });

  describe('collection DELETE (unique: false)', () => {
    it('returns the deleted count', async () => {
      service.deleteBy.mockResolvedValue(5);

      const res = await request(
        buildApp(service, {
          field: 'status',
          unique: false,
          methods: ['DELETE'],
          entityName: 'Notification',
        }),
      ).delete('/notifications/status/sent');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 5 });
    });
  });

  describe('method gating', () => {
    it('does not register handlers for methods left out of the list', async () => {
      const app = buildApp(service, {
        field: 'status',
        unique: false,
        methods: ['GET'],
        entityName: 'Notification',
      });

      const putRes = await request(app).put('/notifications/status/sent').send({});
      const deleteRes = await request(app).delete('/notifications/status/sent');

      expect(putRes.status).toBe(404);
      expect(deleteRes.status).toBe(404);
    });
  });
});
