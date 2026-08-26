import { Request, Response, NextFunction } from 'express';
import { protectBuiltinRow } from '../protectBuiltinRow';
import { IEntityService } from '../../services/interfaces/IEntityService';
import { createMockCrudService } from '../../services/__tests__/mockCrudService';

interface BuiltinEntity {
  id: number;
  uuid: string;
  name: string;
  is_builtin: boolean;
  created: string;
  updated: string;
}

function createMockRequest(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    method: 'GET',
    params: { id: '1' },
    body: {},
    ...overrides,
  };
}

function createMockResponse(): {
  res: Partial<Response>;
  statusFn: jest.Mock;
  jsonFn: jest.Mock;
} {
  const jsonFn = jest.fn();
  const statusFn = jest.fn().mockReturnValue({ json: jsonFn });
  return {
    res: { status: statusFn } as Partial<Response>,
    statusFn,
    jsonFn,
  };
}

function createBuiltinEntity(overrides: Partial<BuiltinEntity> = {}): BuiltinEntity {
  return {
    id: 1,
    uuid: 'admin-uuid',
    name: 'admin',
    is_builtin: true,
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function createNonBuiltinEntity(overrides: Partial<BuiltinEntity> = {}): BuiltinEntity {
  return {
    id: 2,
    uuid: 'custom-uuid',
    name: 'custom',
    is_builtin: false,
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('protectBuiltinRow', () => {
  let service: jest.Mocked<IEntityService<BuiltinEntity>>;
  let next: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    service = createMockCrudService<BuiltinEntity>('integer');
    next = jest.fn();
  });

  describe('DELETE on a builtin row', () => {
    it('should return 403 with correct error message', async () => {
      service.findById.mockResolvedValue(createBuiltinEntity());

      const middleware = protectBuiltinRow(service, 'Scope');
      const req = createMockRequest({
        method: 'DELETE',
        params: { id: '1' },
      });
      const { res, statusFn, jsonFn } = createMockResponse();

      await middleware(req as Request, res as Response, next);

      expect(statusFn).toHaveBeenCalledWith(403);
      expect(jsonFn).toHaveBeenCalledWith({
        errors: [
          {
            code: 'FORBIDDEN',
            message: "Cannot delete Scope because it's a builtin row",
          },
        ],
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('PUT on a builtin row without name change', () => {
    it('should allow the update (call next)', async () => {
      service.findById.mockResolvedValue(createBuiltinEntity());

      const middleware = protectBuiltinRow(service, 'Role');
      const req = createMockRequest({
        method: 'PUT',
        params: { id: '1' },
        body: { name: 'admin', description: 'updated desc', is_enabled: false },
      });
      const { res } = createMockResponse();

      await middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('PATCH on a builtin row without name change', () => {
    it('should allow the update (call next)', async () => {
      service.findById.mockResolvedValue(createBuiltinEntity());

      const middleware = protectBuiltinRow(service, 'Role');
      const req = createMockRequest({
        method: 'PATCH',
        params: { id: '1' },
        body: { description: 'updated desc' },
      });
      const { res } = createMockResponse();

      await middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('PATCH on a builtin row toggling is_enabled', () => {
    it('should allow the update (call next)', async () => {
      service.findById.mockResolvedValue(createBuiltinEntity());

      const middleware = protectBuiltinRow(service, 'Scope');
      const req = createMockRequest({
        method: 'PATCH',
        params: { id: '1' },
        body: { is_enabled: false },
      });
      const { res } = createMockResponse();

      await middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('PUT on a builtin row with name change (rename)', () => {
    it('should return 403 with rename error message', async () => {
      service.findById.mockResolvedValue(createBuiltinEntity());

      const middleware = protectBuiltinRow(service, 'Role');
      const req = createMockRequest({
        method: 'PUT',
        params: { id: '1' },
        body: { name: 'renamed', description: 'updated desc' },
      });
      const { res, statusFn, jsonFn } = createMockResponse();

      await middleware(req as Request, res as Response, next);

      expect(statusFn).toHaveBeenCalledWith(403);
      expect(jsonFn).toHaveBeenCalledWith({
        errors: [
          {
            code: 'FORBIDDEN',
            message: "Cannot rename Role because it's a builtin row",
          },
        ],
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('PATCH on a builtin row with name change (rename)', () => {
    it('should return 403 with rename error message', async () => {
      service.findById.mockResolvedValue(createBuiltinEntity());

      const middleware = protectBuiltinRow(service, 'Scope');
      const req = createMockRequest({
        method: 'PATCH',
        params: { id: '1' },
        body: { name: 'renamed' },
      });
      const { res, statusFn, jsonFn } = createMockResponse();

      await middleware(req as Request, res as Response, next);

      expect(statusFn).toHaveBeenCalledWith(403);
      expect(jsonFn).toHaveBeenCalledWith({
        errors: [
          {
            code: 'FORBIDDEN',
            message: "Cannot rename Scope because it's a builtin row",
          },
        ],
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('PUT/PATCH on a builtin row strips is_builtin from body', () => {
    it('should remove is_builtin from request body', async () => {
      service.findById.mockResolvedValue(createBuiltinEntity());

      const middleware = protectBuiltinRow(service, 'Role');
      const body = { description: 'updated', is_builtin: false };
      const req = createMockRequest({
        method: 'PATCH',
        params: { id: '1' },
        body,
      });
      const { res } = createMockResponse();

      await middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith();
      expect(body).not.toHaveProperty('is_builtin');
    });
  });

  describe('when row is not builtin', () => {
    it('should call next for PUT', async () => {
      service.findById.mockResolvedValue(createNonBuiltinEntity());

      const middleware = protectBuiltinRow(service, 'Role');
      const req = createMockRequest({ method: 'PUT', params: { id: '2' } });
      const { res } = createMockResponse();

      await middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('should call next for PATCH', async () => {
      service.findById.mockResolvedValue(createNonBuiltinEntity());

      const middleware = protectBuiltinRow(service, 'Role');
      const req = createMockRequest({ method: 'PATCH', params: { id: '2' } });
      const { res } = createMockResponse();

      await middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('should call next for DELETE', async () => {
      service.findById.mockResolvedValue(createNonBuiltinEntity());

      const middleware = protectBuiltinRow(service, 'Scope');
      const req = createMockRequest({
        method: 'DELETE',
        params: { id: '2' },
      });
      const { res } = createMockResponse();

      await middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('when method is GET', () => {
    it('should call next without checking the entity', async () => {
      const middleware = protectBuiltinRow(service, 'Role');
      const req = createMockRequest({ method: 'GET', params: { id: '1' } });
      const { res } = createMockResponse();

      await middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith();
      expect(service.findById).not.toHaveBeenCalled();
    });
  });

  describe('when method is POST', () => {
    it('should call next without checking the entity', async () => {
      const middleware = protectBuiltinRow(service, 'Role');
      const req = createMockRequest({ method: 'POST', params: {} });
      const { res } = createMockResponse();

      await middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith();
      expect(service.findById).not.toHaveBeenCalled();
    });
  });

  describe('when entity is not found', () => {
    it('should call next to let the route handler return 404', async () => {
      service.findById.mockResolvedValue(null);

      const middleware = protectBuiltinRow(service, 'Role');
      const req = createMockRequest({ method: 'PUT', params: { id: '999' } });
      const { res } = createMockResponse();

      await middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('when id param is invalid', () => {
    it('should call next to let the route handler handle validation', async () => {
      const middleware = protectBuiltinRow(service, 'Role');
      const req = createMockRequest({
        method: 'DELETE',
        params: { id: 'abc' },
      });
      const { res } = createMockResponse();

      await middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith();
      expect(service.findById).not.toHaveBeenCalled();
    });
  });

  describe('when service throws an error', () => {
    it('should pass the error to next', async () => {
      const error = new Error('Database connection failed');
      service.findById.mockRejectedValue(error);

      const middleware = protectBuiltinRow(service, 'Role');
      const req = createMockRequest({ method: 'PUT', params: { id: '1' } });
      const { res } = createMockResponse();

      await middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(error);
    });
  });

  describe('entity name in error message', () => {
    it('should use the provided entity name for delete', async () => {
      service.findById.mockResolvedValue(createBuiltinEntity());

      const middleware = protectBuiltinRow(service, 'Scope');
      const req = createMockRequest({
        method: 'DELETE',
        params: { id: '1' },
      });
      const { res, jsonFn } = createMockResponse();

      await middleware(req as Request, res as Response, next);

      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: [
            expect.objectContaining({
              message: "Cannot delete Scope because it's a builtin row",
            }),
          ],
        }),
      );
    });

    it('should use the provided entity name for rename', async () => {
      service.findById.mockResolvedValue(createBuiltinEntity());

      const middleware = protectBuiltinRow(service, 'Permission');
      const req = createMockRequest({
        method: 'PATCH',
        params: { id: '1' },
        body: { name: 'new-name' },
      });
      const { res, jsonFn } = createMockResponse();

      await middleware(req as Request, res as Response, next);

      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: [
            expect.objectContaining({
              message: "Cannot rename Permission because it's a builtin row",
            }),
          ],
        }),
      );
    });
  });
});
