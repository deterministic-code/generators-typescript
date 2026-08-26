import request from 'supertest';
import express, { Application, Router } from 'express';
import { z } from 'zod';
import { IEntityService } from '../../services/interfaces/IEntityService';
import { addNestedManyToManyRoutes, NestedManyToManyConfig } from '../nestedManyToManyRoutes';
import { createMockCrudService as createMockService } from '../../services/__tests__/mockCrudService';

interface ParentEntity {
  id: number;
  uuid: string;
  name: string;
  created: string;
  updated: string;
}

interface JunctionEntity {
  id: number;
  uuid: string;
  parent_id: number;
  child_id: number;
  created: string;
  updated: string;
}

function buildApp(
  parentService: jest.Mocked<IEntityService<ParentEntity>>,
  junctionService: jest.Mocked<IEntityService<JunctionEntity>>,
  config: Omit<
    NestedManyToManyConfig<ParentEntity, JunctionEntity>,
    'parentService' | 'junctionService'
  >,
): Application {
  const app = express();
  app.use(express.json());
  const router = Router();
  addNestedManyToManyRoutes(router, {
    ...config,
    parentService,
    junctionService,
  });
  app.use('/api/parents', router);
  return app;
}

describe('addNestedManyToManyRoutes', () => {
  let parentService: jest.Mocked<IEntityService<ParentEntity>>;
  let junctionService: jest.Mocked<IEntityService<JunctionEntity>>;
  let app: Application;

  const parent: ParentEntity = {
    id: 1,
    uuid: 'p1',
    name: 'Test Parent',
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
  };

  const junctionRecords: JunctionEntity[] = [
    {
      id: 1,
      uuid: 'j1',
      parent_id: 1,
      child_id: 10,
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
    },
    {
      id: 2,
      uuid: 'j2',
      parent_id: 1,
      child_id: 20,
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
    },
    {
      id: 3,
      uuid: 'j3',
      parent_id: 2,
      child_id: 30,
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
    },
  ];

  const config = {
    parentParamName: 'parentId',
    parentEntityName: 'Parent',
    childParamName: 'childId',
    childEntityName: 'Child',
    nestedPath: 'children',
    parentFkField: 'parent_id' as keyof JunctionEntity & string,
    childFkField: 'child_id' as keyof JunctionEntity & string,
    bodyFields: ['child_id'] as Array<keyof JunctionEntity & string>,
  };

  beforeEach(() => {
    parentService = createMockService<ParentEntity>('integer');
    junctionService = createMockService<JunctionEntity>('integer');
    app = buildApp(parentService, junctionService, config);
  });

  describe('GET /:parentId/children', () => {
    it('returns 200 with filtered junction records for a valid parent', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockResolvedValue(junctionRecords);

      const res = await request(app).get('/api/parents/1/children');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        items: junctionRecords.filter((j) => j.parent_id === 1),
      });
      expect(parentService.findById).toHaveBeenCalledWith(1);
      expect(junctionService.findAll).toHaveBeenCalledTimes(1);
    });

    it('returns 404 when parent does not exist', async () => {
      parentService.findById.mockResolvedValue(null);

      const res = await request(app).get('/api/parents/999/children');

      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
      expect(res.body.errors[0].message).toContain('Parent');
    });

    it('returns 400 when parentId is not a valid number', async () => {
      const res = await request(app).get('/api/parents/abc/children');

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when parentId is zero', async () => {
      const res = await request(app).get('/api/parents/0/children');

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when parentId is negative', async () => {
      const res = await request(app).get('/api/parents/-1/children');

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('returns empty array when parent has no junction records', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockResolvedValue([]);

      const res = await request(app).get('/api/parents/1/children');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [] });
    });
  });

  describe('POST /:parentId/children', () => {
    it('returns 201 with the created junction record', async () => {
      parentService.findById.mockResolvedValue(parent);

      const created: JunctionEntity = {
        id: 4,
        uuid: 'j4',
        parent_id: 1,
        child_id: 40,
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      };
      junctionService.create.mockResolvedValue(created);

      const res = await request(app).post('/api/parents/1/children').send({ child_id: 40 });

      expect(res.status).toBe(201);
      expect(res.body).toEqual(created);
      expect(junctionService.create).toHaveBeenCalledWith({
        parent_id: 1,
        child_id: 40,
      });
    });

    it('returns 404 when parent does not exist', async () => {
      parentService.findById.mockResolvedValue(null);

      const res = await request(app).post('/api/parents/999/children').send({ child_id: 10 });

      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
    });

    it('returns 400 when parentId is not a valid number', async () => {
      const res = await request(app).post('/api/parents/abc/children').send({ child_id: 10 });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when required body field is missing', async () => {
      parentService.findById.mockResolvedValue(parent);

      const res = await request(app).post('/api/parents/1/children').send({});

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when body field is not a positive integer', async () => {
      parentService.findById.mockResolvedValue(parent);

      const res = await request(app).post('/api/parents/1/children').send({ child_id: -5 });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when body field is zero', async () => {
      parentService.findById.mockResolvedValue(parent);

      const res = await request(app).post('/api/parents/1/children').send({ child_id: 0 });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });
  });

  describe('DELETE /:parentId/children/:childId', () => {
    it('returns 200 with success when junction record is deleted', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockResolvedValue(junctionRecords);
      junctionService.delete.mockResolvedValue(true);

      const res = await request(app).delete('/api/parents/1/children/10');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(junctionService.delete).toHaveBeenCalledWith(1);
    });

    it('returns 404 when parent does not exist', async () => {
      parentService.findById.mockResolvedValue(null);

      const res = await request(app).delete('/api/parents/999/children/10');

      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
    });

    it('returns 404 when junction mapping does not exist', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockResolvedValue([]);

      const res = await request(app).delete('/api/parents/1/children/999');

      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
      expect(res.body.errors[0].message).toContain('Child');
    });

    it('returns 400 when parentId is not a valid number', async () => {
      const res = await request(app).delete('/api/parents/abc/children/10');

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when childId is not a valid number', async () => {
      const res = await request(app).delete('/api/parents/1/children/abc');

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });
  });

  describe('error propagation', () => {
    it('calls next with error when junctionService.findAll throws in GET', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockRejectedValue(new Error('DB error'));

      const errorApp = express();
      errorApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...config,
        parentService,
        junctionService,
      });
      errorApp.use('/api/parents', router);
      errorApp.use(
        (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
          res.status(500).json({
            errors: [{ code: 'INTERNAL_ERROR', message: err.message }],
          });
        },
      );

      const res = await request(errorApp).get('/api/parents/1/children');

      expect(res.status).toBe(500);
      expect(res.body.errors[0].code).toBe('INTERNAL_ERROR');
    });

    it('calls next with error when junctionService.create throws in POST', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.create.mockRejectedValue(new Error('DB error'));

      const errorApp = express();
      errorApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...config,
        parentService,
        junctionService,
      });
      errorApp.use('/api/parents', router);
      errorApp.use(
        (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
          res.status(500).json({
            errors: [{ code: 'INTERNAL_ERROR', message: err.message }],
          });
        },
      );

      const res = await request(errorApp).post('/api/parents/1/children').send({ child_id: 10 });

      expect(res.status).toBe(500);
      expect(res.body.errors[0].code).toBe('INTERNAL_ERROR');
    });

    it('calls next with error when junctionService.findAll throws in DELETE', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockRejectedValue(new Error('DB error'));

      const errorApp = express();
      errorApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...config,
        parentService,
        junctionService,
      });
      errorApp.use('/api/parents', router);
      errorApp.use(
        (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
          res.status(500).json({
            errors: [{ code: 'INTERNAL_ERROR', message: err.message }],
          });
        },
      );

      const res = await request(errorApp).delete('/api/parents/1/children/10');

      expect(res.status).toBe(500);
      expect(res.body.errors[0].code).toBe('INTERNAL_ERROR');
    });
  });

  describe('settings-style nested routes (name+value body fields)', () => {
    interface SettingJunction {
      id: number;
      uuid: string;
      parent_id: number;
      name: string;
      value: string;
      created: string;
      updated: string;
    }

    let settingService: jest.Mocked<IEntityService<SettingJunction>>;

    const settingsConfig: Omit<
      NestedManyToManyConfig<ParentEntity, SettingJunction>,
      'parentService' | 'junctionService'
    > = {
      parentParamName: 'parentId',
      parentEntityName: 'Parent',
      childParamName: 'settingId',
      childEntityName: 'Setting',
      nestedPath: 'settings',
      parentFkField: 'parent_id' as keyof SettingJunction & string,
      childFkField: 'id' as keyof SettingJunction & string,
      bodyFields: ['name', 'value'] as Array<keyof SettingJunction & string>,
      bodyFieldTypes: { name: 'string', value: 'string_allow_empty' },
    };

    beforeEach(() => {
      settingService = createMockService<SettingJunction>('integer');
    });

    it('POST creates a setting with name and value from body', async () => {
      parentService.findById.mockResolvedValue(parent);

      const created: SettingJunction = {
        id: 1,
        uuid: 's1',
        parent_id: 1,
        name: 'theme',
        value: 'dark',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      };
      settingService.create.mockResolvedValue(created);

      const settingsApp = express();
      settingsApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...settingsConfig,
        parentService,
        junctionService: settingService,
      });
      settingsApp.use('/api/parents', router);

      const res = await request(settingsApp)
        .post('/api/parents/1/settings')
        .send({ name: 'theme', value: 'dark' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual(created);
      expect(settingService.create).toHaveBeenCalledWith({
        parent_id: 1,
        name: 'theme',
        value: 'dark',
      });
    });

    it('POST returns 400 when name is missing', async () => {
      parentService.findById.mockResolvedValue(parent);

      const settingsApp = express();
      settingsApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...settingsConfig,
        parentService,
        junctionService: settingService,
      });
      settingsApp.use('/api/parents', router);

      const res = await request(settingsApp)
        .post('/api/parents/1/settings')
        .send({ value: 'dark' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('DELETE finds by parent_id and the setting record id', async () => {
      parentService.findById.mockResolvedValue(parent);

      const settings: SettingJunction[] = [
        {
          id: 5,
          uuid: 's5',
          parent_id: 1,
          name: 'theme',
          value: 'dark',
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        },
      ];
      settingService.findAll.mockResolvedValue(settings);
      settingService.delete.mockResolvedValue(true);

      const settingsApp = express();
      settingsApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...settingsConfig,
        parentService,
        junctionService: settingService,
      });
      settingsApp.use('/api/parents', router);

      const res = await request(settingsApp).delete('/api/parents/1/settings/5');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(settingService.delete).toHaveBeenCalledWith(5);
    });
  });

  describe('boolean body field type support', () => {
    interface BooleanJunction {
      id: number;
      uuid: string;
      parent_id: number;
      child_id: number;
      is_required: boolean;
      rank: number;
      created: string;
      updated: string;
    }

    let boolService: jest.Mocked<IEntityService<BooleanJunction>>;

    const boolConfig: Omit<
      NestedManyToManyConfig<ParentEntity, BooleanJunction>,
      'parentService' | 'junctionService'
    > = {
      parentParamName: 'parentId',
      parentEntityName: 'Parent',
      childParamName: 'childId',
      childEntityName: 'Child',
      nestedPath: 'children',
      parentFkField: 'parent_id' as keyof BooleanJunction & string,
      childFkField: 'id' as keyof BooleanJunction & string,
      bodyFields: ['child_id', 'is_required', 'rank'] as Array<keyof BooleanJunction & string>,
      bodyFieldTypes: { is_required: 'boolean' },
    };

    beforeEach(() => {
      boolService = createMockService<BooleanJunction>('integer');
    });

    it('POST creates a record with boolean field set to false', async () => {
      parentService.findById.mockResolvedValue(parent);

      const created: BooleanJunction = {
        id: 2,
        uuid: 'b2',
        parent_id: 1,
        child_id: 20,
        is_required: false,
        rank: 2,
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      };
      boolService.create.mockResolvedValue(created);

      const boolApp = express();
      boolApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...boolConfig,
        parentService,
        junctionService: boolService,
      });
      boolApp.use('/api/parents', router);

      const res = await request(boolApp)
        .post('/api/parents/1/children')
        .send({ child_id: 20, is_required: false, rank: 2 });

      expect(res.status).toBe(201);
      expect(res.body).toEqual(created);
      expect(boolService.create).toHaveBeenCalledWith({
        parent_id: 1,
        child_id: 20,
        is_required: false,
        rank: 2,
      });
    });

    it('POST returns 400 when boolean field receives a non-boolean value', async () => {
      parentService.findById.mockResolvedValue(parent);

      const boolApp = express();
      boolApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...boolConfig,
        parentService,
        junctionService: boolService,
      });
      boolApp.use('/api/parents', router);

      const res = await request(boolApp)
        .post('/api/parents/1/children')
        .send({ child_id: 10, is_required: 'yes', rank: 1 });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });
  });

  describe('childService resolution (pure M2M)', () => {
    interface ChildEntity {
      id: number;
      uuid: string;
      name: string;
      created: string;
      updated: string;
    }

    let childService: jest.Mocked<IEntityService<ChildEntity>>;

    const childEntities: ChildEntity[] = [
      {
        id: 10,
        uuid: 'c10',
        name: 'Child A',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      },
      {
        id: 20,
        uuid: 'c20',
        name: 'Child B',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      },
      {
        id: 30,
        uuid: 'c30',
        name: 'Child C',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      },
    ];

    function buildAppWithChild(
      pService: jest.Mocked<IEntityService<ParentEntity>>,
      jService: jest.Mocked<IEntityService<JunctionEntity>>,
      cService: jest.Mocked<IEntityService<ChildEntity>>,
    ): Application {
      const app = express();
      app.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...config,
        parentService: pService,
        junctionService: jService,
        childService: cService,
      });
      app.use('/api/parents', router);
      return app;
    }

    beforeEach(() => {
      childService = createMockService<ChildEntity>('integer');
    });

    describe('GET with childService', () => {
      it('returns resolved child entities instead of junction records', async () => {
        parentService.findById.mockResolvedValue(parent);
        junctionService.findAll.mockResolvedValue(junctionRecords);
        childService.findAll.mockResolvedValue(childEntities);

        const childApp = buildAppWithChild(parentService, junctionService, childService);
        const res = await request(childApp).get('/api/parents/1/children');

        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(2);
        expect(res.body.items[0]).toEqual(childEntities[0]);
        expect(res.body.items[1]).toEqual(childEntities[1]);
        expect(childService.findAll).toHaveBeenCalledTimes(1);
      });

      it('returns empty array when parent has no junction records', async () => {
        parentService.findById.mockResolvedValue(parent);
        junctionService.findAll.mockResolvedValue([]);

        const childApp = buildAppWithChild(parentService, junctionService, childService);
        const res = await request(childApp).get('/api/parents/1/children');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ items: [] });
        expect(childService.findAll).not.toHaveBeenCalled();
      });

      it('skips junction records whose child FK has no matching child entity', async () => {
        parentService.findById.mockResolvedValue(parent);
        junctionService.findAll.mockResolvedValue(junctionRecords);
        childService.findAll.mockResolvedValue([childEntities[0]]);

        const childApp = buildAppWithChild(parentService, junctionService, childService);
        const res = await request(childApp).get('/api/parents/1/children');

        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0]).toEqual(childEntities[0]);
      });
    });

    describe('POST with childService', () => {
      it('returns the resolved child entity instead of junction record', async () => {
        parentService.findById.mockResolvedValue(parent);

        const createdJunction: JunctionEntity = {
          id: 4,
          uuid: 'j4',
          parent_id: 1,
          child_id: 10,
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        };
        junctionService.create.mockResolvedValue(createdJunction);
        childService.findById.mockResolvedValue(childEntities[0]);

        const childApp = buildAppWithChild(parentService, junctionService, childService);
        const res = await request(childApp).post('/api/parents/1/children').send({ child_id: 10 });

        expect(res.status).toBe(201);
        expect(res.body).toEqual(childEntities[0]);
        expect(childService.findById).toHaveBeenCalledWith(10);
      });

      it('returns 404 and does NOT create a junction when the linked child does not exist', async () => {
        parentService.findById.mockResolvedValue(parent);
        childService.findById.mockResolvedValue(null);

        const childApp = buildAppWithChild(parentService, junctionService, childService);
        const res = await request(childApp).post('/api/parents/1/children').send({ child_id: 999 });

        expect(res.status).toBe(404);
        expect(res.body?.errors?.[0]?.code).toBe('NOT_FOUND');
        expect(junctionService.create).not.toHaveBeenCalled();
      });
    });

    describe('backward compatibility without childService', () => {
      it('GET returns junction records when no childService is provided', async () => {
        parentService.findById.mockResolvedValue(parent);
        junctionService.findAll.mockResolvedValue(junctionRecords);

        const res = await request(app).get('/api/parents/1/children');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          items: junctionRecords.filter((j) => j.parent_id === 1),
        });
      });

      it('POST returns junction record when no childService is provided', async () => {
        parentService.findById.mockResolvedValue(parent);

        const created: JunctionEntity = {
          id: 4,
          uuid: 'j4',
          parent_id: 1,
          child_id: 40,
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        };
        junctionService.create.mockResolvedValue(created);

        const res = await request(app).post('/api/parents/1/children').send({ child_id: 40 });

        expect(res.status).toBe(201);
        expect(res.body).toEqual(created);
      });
    });
  });

  describe('create-and-link POST (childCreateSchema)', () => {
    interface ChildEntity {
      id: number;
      uuid: string;
      name: string;
      description: string | null;
      created: string;
      updated: string;
    }

    const childCreateSchema = z.object({
      name: z.string().trim().min(1),
      description: z.string().nullable().optional().default(null),
    });

    let childService: jest.Mocked<IEntityService<ChildEntity>>;

    function buildCreateAndLinkApp(
      pService: jest.Mocked<IEntityService<ParentEntity>>,
      jService: jest.Mocked<IEntityService<JunctionEntity>>,
      cService: jest.Mocked<IEntityService<ChildEntity>>,
    ): Application {
      const testApp = express();
      testApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...config,
        parentService: pService,
        junctionService: jService,
        childService: cService,
        childCreateSchema,
      });
      testApp.use('/api/parents', router);
      return testApp;
    }

    beforeEach(() => {
      childService = createMockService<ChildEntity>('integer');
    });

    it('POST creates child entity and junction, returns child', async () => {
      parentService.findById.mockResolvedValue(parent);

      const createdChild: ChildEntity = {
        id: 50,
        uuid: 'c50',
        name: 'New Child',
        description: null,
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      };
      childService.create.mockResolvedValue(createdChild);

      const createdJunction: JunctionEntity = {
        id: 10,
        uuid: 'j10',
        parent_id: 1,
        child_id: 50,
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      };
      junctionService.create.mockResolvedValue(createdJunction);

      const testApp = buildCreateAndLinkApp(parentService, junctionService, childService);
      const res = await request(testApp)
        .post('/api/parents/1/children')
        .send({ name: 'New Child' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual(createdChild);
      expect(childService.create).toHaveBeenCalledWith({ name: 'New Child', description: null });
      expect(junctionService.create).toHaveBeenCalledWith({ parent_id: 1, child_id: 50 });
    });

    it('POST returns 400 when required child field is missing', async () => {
      parentService.findById.mockResolvedValue(parent);

      const testApp = buildCreateAndLinkApp(parentService, junctionService, childService);
      const res = await request(testApp).post('/api/parents/1/children').send({});

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('POST returns 404 when parent does not exist', async () => {
      parentService.findById.mockResolvedValue(null);

      const testApp = buildCreateAndLinkApp(parentService, junctionService, childService);
      const res = await request(testApp)
        .post('/api/parents/999/children')
        .send({ name: 'New Child' });

      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
    });

    it('POST passes optional fields with defaults to child create', async () => {
      parentService.findById.mockResolvedValue(parent);

      const createdChild: ChildEntity = {
        id: 51,
        uuid: 'c51',
        name: 'With Desc',
        description: 'A description',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      };
      childService.create.mockResolvedValue(createdChild);
      junctionService.create.mockResolvedValue({
        id: 11,
        parent_id: 1,
        child_id: 51,
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      });

      const testApp = buildCreateAndLinkApp(parentService, junctionService, childService);
      const res = await request(testApp)
        .post('/api/parents/1/children')
        .send({ name: 'With Desc', description: 'A description' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual(createdChild);
      expect(childService.create).toHaveBeenCalledWith({
        name: 'With Desc',
        description: 'A description',
      });
    });

    it('GET still returns resolved child entities when childCreateSchema is present', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockResolvedValue(junctionRecords);

      const allChildren: ChildEntity[] = [
        {
          id: 10,
          uuid: 'c10',
          name: 'Child A',
          description: null,
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        },
        {
          id: 20,
          uuid: 'c20',
          name: 'Child B',
          description: null,
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        },
      ];
      childService.findAll.mockResolvedValue(allChildren);

      const testApp = buildCreateAndLinkApp(parentService, junctionService, childService);
      const res = await request(testApp).get('/api/parents/1/children');

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items[0]).toEqual(allChildren[0]);
    });

    it('DELETE still works normally when childCreateSchema is present', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockResolvedValue(junctionRecords);
      junctionService.delete.mockResolvedValue(true);

      const testApp = buildCreateAndLinkApp(parentService, junctionService, childService);
      const res = await request(testApp).delete('/api/parents/1/children/10');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });
  });

  describe('PUT /:parentId/children/:childId (link existing child)', () => {
    interface ChildEntity {
      id: number;
      uuid: string;
      name: string;
      created: string;
      updated: string;
    }

    let childService: jest.Mocked<IEntityService<ChildEntity>>;

    const childEntities: ChildEntity[] = [
      {
        id: 10,
        uuid: 'c10',
        name: 'Child A',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      },
      {
        id: 20,
        uuid: 'c20',
        name: 'Child B',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      },
    ];

    function buildPutApp(
      pService: jest.Mocked<IEntityService<ParentEntity>>,
      jService: jest.Mocked<IEntityService<JunctionEntity>>,
      cService: jest.Mocked<IEntityService<ChildEntity>>,
    ): Application {
      const testApp = express();
      testApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...config,
        parentService: pService,
        junctionService: jService,
        childService: cService,
      });
      testApp.use('/api/parents', router);
      return testApp;
    }

    beforeEach(() => {
      childService = createMockService<ChildEntity>('integer');
    });

    it('returns 200 with child entity when linking succeeds', async () => {
      parentService.findById.mockResolvedValue(parent);
      childService.findById.mockResolvedValue(childEntities[0]);
      junctionService.findAll.mockResolvedValue([]);
      junctionService.create.mockResolvedValue({
        id: 5,
        parent_id: 1,
        child_id: 10,
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      });

      const putApp = buildPutApp(parentService, junctionService, childService);
      const res = await request(putApp).put('/api/parents/1/children/10');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(childEntities[0]);
      expect(junctionService.create).toHaveBeenCalledWith({
        parent_id: 1,
        child_id: 10,
      });
    });

    it('returns 200 with child entity when junction already exists (idempotent)', async () => {
      parentService.findById.mockResolvedValue(parent);
      childService.findById.mockResolvedValue(childEntities[0]);
      junctionService.findAll.mockResolvedValue([
        {
          id: 5,
          parent_id: 1,
          child_id: 10,
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        },
      ]);

      const putApp = buildPutApp(parentService, junctionService, childService);
      const res = await request(putApp).put('/api/parents/1/children/10');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(childEntities[0]);
      expect(junctionService.create).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid parentId', async () => {
      const putApp = buildPutApp(parentService, junctionService, childService);
      const res = await request(putApp).put('/api/parents/abc/children/10');

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid childId', async () => {
      const putApp = buildPutApp(parentService, junctionService, childService);
      const res = await request(putApp).put('/api/parents/1/children/abc');

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 when parent not found', async () => {
      parentService.findById.mockResolvedValue(null);

      const putApp = buildPutApp(parentService, junctionService, childService);
      const res = await request(putApp).put('/api/parents/999/children/10');

      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
      expect(res.body.errors[0].message).toContain('Parent');
    });

    it('returns 404 when child not found', async () => {
      parentService.findById.mockResolvedValue(parent);
      childService.findById.mockResolvedValue(null);

      const putApp = buildPutApp(parentService, junctionService, childService);
      const res = await request(putApp).put('/api/parents/1/children/999');

      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
      expect(res.body.errors[0].message).toContain('Child');
    });

    it('does NOT register PUT route when childService is absent (settings mode)', async () => {
      const res = await request(app).put('/api/parents/1/children/10');

      expect(res.status).toBe(404);
    });

    it('updates child properties when body is provided and childPatchSchema is configured', async () => {
      const patchSchema = z.object({
        name: z.string().min(1).optional(),
      });

      const updatedChild: ChildEntity = {
        id: 10,
        uuid: 'c10',
        name: 'Updated Name',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      };

      parentService.findById.mockResolvedValue(parent);
      childService.findById.mockResolvedValue(childEntities[0]);
      childService.update.mockResolvedValue(updatedChild);
      junctionService.findAll.mockResolvedValue([
        {
          id: 5,
          parent_id: 1,
          child_id: 10,
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        },
      ]);

      const testApp = express();
      testApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...config,
        parentService: parentService,
        junctionService: junctionService,
        childService: childService,
        childPatchSchema: patchSchema,
      });
      testApp.use('/api/parents', router);

      const res = await request(testApp)
        .put('/api/parents/1/children/10')
        .send({ name: 'Updated Name' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated Name');
      expect(childService.update).toHaveBeenCalledWith(10, { name: 'Updated Name' });
    });

    it('links and updates child when junction does not exist and body is provided', async () => {
      const patchSchema = z.object({
        name: z.string().min(1).optional(),
      });

      const updatedChild: ChildEntity = {
        id: 10,
        uuid: 'c10',
        name: 'Updated Name',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      };

      parentService.findById.mockResolvedValue(parent);
      childService.findById.mockResolvedValue(childEntities[0]);
      childService.update.mockResolvedValue(updatedChild);
      junctionService.findAll.mockResolvedValue([]);
      junctionService.create.mockResolvedValue({
        id: 5,
        parent_id: 1,
        child_id: 10,
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      });

      const testApp = express();
      testApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...config,
        parentService: parentService,
        junctionService: junctionService,
        childService: childService,
        childPatchSchema: patchSchema,
      });
      testApp.use('/api/parents', router);

      const res = await request(testApp)
        .put('/api/parents/1/children/10')
        .send({ name: 'Updated Name' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated Name');
      expect(junctionService.create).toHaveBeenCalled();
      expect(childService.update).toHaveBeenCalledWith(10, { name: 'Updated Name' });
    });
  });

  describe('PATCH /:parentId/children/:childId (partial update child)', () => {
    interface ChildEntity {
      id: number;
      uuid: string;
      name: string;
      is_enabled: boolean;
      revoked: string | null;
      created: string;
      updated: string;
    }

    const childPatchSchema = z
      .object({
        is_enabled: z.boolean().optional(),
        revoked: z.string().min(1).nullable().optional(),
      })
      .strict();

    let childService: jest.Mocked<IEntityService<ChildEntity>>;

    const childEntities: ChildEntity[] = [
      {
        id: 10,
        uuid: 'c10',
        name: 'Child A',
        is_enabled: true,
        revoked: null,
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      },
    ];

    function buildPatchApp(
      pService: jest.Mocked<IEntityService<ParentEntity>>,
      jService: jest.Mocked<IEntityService<JunctionEntity>>,
      cService: jest.Mocked<IEntityService<ChildEntity>>,
    ): Application {
      const testApp = express();
      testApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...config,
        parentService: pService,
        junctionService: jService,
        childService: cService,
        childPatchSchema,
      });
      testApp.use('/api/parents', router);
      return testApp;
    }

    beforeEach(() => {
      childService = createMockService<ChildEntity>('integer');
    });

    it('returns 200 with updated child entity when patch succeeds', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockResolvedValue(junctionRecords);

      const updated = { ...childEntities[0], is_enabled: false };
      childService.update.mockResolvedValue(updated);

      const patchApp = buildPatchApp(parentService, junctionService, childService);
      const res = await request(patchApp)
        .patch('/api/parents/1/children/10')
        .send({ is_enabled: false });

      expect(res.status).toBe(200);
      expect(res.body.is_enabled).toBe(false);
      expect(childService.update).toHaveBeenCalledWith(10, { is_enabled: false });
    });

    it('returns 200 when revoked is set to a date string', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockResolvedValue(junctionRecords);

      const revokedDate = '2026-06-01T00:00:00Z';
      const updated = { ...childEntities[0], revoked: revokedDate };
      childService.update.mockResolvedValue(updated);

      const patchApp = buildPatchApp(parentService, junctionService, childService);
      const res = await request(patchApp)
        .patch('/api/parents/1/children/10')
        .send({ revoked: revokedDate });

      expect(res.status).toBe(200);
      expect(res.body.revoked).toBe(revokedDate);
    });

    it('returns 200 when revoked is set to null', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockResolvedValue(junctionRecords);

      const updated = { ...childEntities[0], revoked: null };
      childService.update.mockResolvedValue(updated);

      const patchApp = buildPatchApp(parentService, junctionService, childService);
      const res = await request(patchApp)
        .patch('/api/parents/1/children/10')
        .send({ revoked: null });

      expect(res.status).toBe(200);
      expect(res.body.revoked).toBeNull();
    });

    it('accepts empty body (no fields to update)', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockResolvedValue(junctionRecords);

      childService.update.mockResolvedValue(childEntities[0]);

      const patchApp = buildPatchApp(parentService, junctionService, childService);
      const res = await request(patchApp).patch('/api/parents/1/children/10').send({});

      expect(res.status).toBe(200);
      expect(childService.update).toHaveBeenCalledWith(10, {});
    });

    it('returns 400 for invalid parentId', async () => {
      const patchApp = buildPatchApp(parentService, junctionService, childService);
      const res = await request(patchApp)
        .patch('/api/parents/abc/children/10')
        .send({ is_enabled: false });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid childId', async () => {
      const patchApp = buildPatchApp(parentService, junctionService, childService);
      const res = await request(patchApp)
        .patch('/api/parents/1/children/abc')
        .send({ is_enabled: false });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 when parent not found', async () => {
      parentService.findById.mockResolvedValue(null);

      const patchApp = buildPatchApp(parentService, junctionService, childService);
      const res = await request(patchApp)
        .patch('/api/parents/999/children/10')
        .send({ is_enabled: false });

      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
      expect(res.body.errors[0].message).toContain('Parent');
    });

    it('returns 404 when parent-child mapping does not exist', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockResolvedValue([]);

      const patchApp = buildPatchApp(parentService, junctionService, childService);
      const res = await request(patchApp)
        .patch('/api/parents/1/children/999')
        .send({ is_enabled: false });

      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
      expect(res.body.errors[0].message).toContain('Child');
    });

    it('returns 404 when childService.update returns null', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockResolvedValue(junctionRecords);
      childService.update.mockResolvedValue(null);

      const patchApp = buildPatchApp(parentService, junctionService, childService);
      const res = await request(patchApp)
        .patch('/api/parents/1/children/10')
        .send({ is_enabled: false });

      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
    });

    it('returns 400 when body contains disallowed fields (strict mode)', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockResolvedValue(junctionRecords);

      const patchApp = buildPatchApp(parentService, junctionService, childService);
      const res = await request(patchApp)
        .patch('/api/parents/1/children/10')
        .send({ name: 'disallowed' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('does NOT register PATCH route when childPatchSchema is absent', async () => {
      const res = await request(app)
        .patch('/api/parents/1/children/10')
        .send({ is_enabled: false });

      expect(res.status).toBe(404);
    });

    it('calls next with error when childService.update throws', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockResolvedValue(junctionRecords);
      childService.update.mockRejectedValue(new Error('DB error'));

      const errorApp = express();
      errorApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...config,
        parentService,
        junctionService,
        childService,
        childPatchSchema,
      });
      errorApp.use('/api/parents', router);
      errorApp.use(
        (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
          res.status(500).json({
            errors: [{ code: 'INTERNAL_ERROR', message: err.message }],
          });
        },
      );

      const res = await request(errorApp)
        .patch('/api/parents/1/children/10')
        .send({ is_enabled: false });

      expect(res.status).toBe(500);
      expect(res.body.errors[0].code).toBe('INTERNAL_ERROR');
    });
  });

  describe('create-and-link with childParentFkField', () => {
    interface ChildWithParentFk {
      id: number;
      uuid: string;
      parent_id: number;
      name: string;
      created: string;
      updated: string;
    }

    const childSchemaWithParentFk = z.object({
      name: z.string().trim().min(1),
    });

    let childService: jest.Mocked<IEntityService<ChildWithParentFk>>;

    function buildAppWithParentFk(
      pService: jest.Mocked<IEntityService<ParentEntity>>,
      jService: jest.Mocked<IEntityService<JunctionEntity>>,
      cService: jest.Mocked<IEntityService<ChildWithParentFk>>,
    ): Application {
      const testApp = express();
      testApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...config,
        parentService: pService,
        junctionService: jService,
        childService: cService,
        childCreateSchema: childSchemaWithParentFk,
        childParentFkField: 'parent_id',
      });
      testApp.use('/api/parents', router);
      return testApp;
    }

    beforeEach(() => {
      childService = createMockService<ChildWithParentFk>('integer');
    });

    it('POST injects parent ID into child create data', async () => {
      parentService.findById.mockResolvedValue(parent);

      const createdChild: ChildWithParentFk = {
        id: 60,
        uuid: 'c60',
        parent_id: 1,
        name: 'Child with FK',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      };
      childService.create.mockResolvedValue(createdChild);
      junctionService.create.mockResolvedValue({
        id: 12,
        uuid: 'j12',
        parent_id: 1,
        child_id: 60,
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      });

      const testApp = buildAppWithParentFk(parentService, junctionService, childService);
      const res = await request(testApp)
        .post('/api/parents/1/children')
        .send({ name: 'Child with FK' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual(createdChild);
      expect(childService.create).toHaveBeenCalledWith({
        parent_id: 1,
        name: 'Child with FK',
      });
      expect(junctionService.create).toHaveBeenCalledWith({
        parent_id: 1,
        child_id: 60,
      });
    });
  });

  describe('PUT handles ZodError via handleZodError', () => {
    it('returns 400 when childPatchSchema rejects body', async () => {
      const parentSvc = createMockService<ParentEntity>('integer');
      const junctionSvc = createMockService<JunctionEntity>('integer');
      const childSvc = createMockService<{
        id: number;
        uuid: string;
        created: string;
        updated: string;
      }>('integer');

      parentSvc.findById.mockResolvedValue({
        id: 1,
        name: 'p',
        created: 't',
        updated: 't',
      });
      childSvc.findById.mockResolvedValue({
        id: 10,
        created: 't',
        updated: 't',
      });
      junctionSvc.findAll.mockResolvedValue([
        {
          id: 5,
          parent_id: 1,
          child_id: 10,
          created: 't',
          updated: 't',
        },
      ]);

      const app = express();
      app.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...config,
        parentService: parentSvc,
        junctionService: junctionSvc,
        childService: childSvc,
        childPatchSchema: z.object({ name: z.string().min(1) }),
      });
      app.use('/api/parents', router);

      const res = await request(app).put('/api/parents/1/children/10').send({ name: '' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });
  });

  describe('PUT catch-block error forwarding', () => {
    it('forwards non-zod errors from the PUT handler to next()', async () => {
      const parentSvc = createMockService<ParentEntity>('integer');
      const junctionSvc = createMockService<JunctionEntity>('integer');
      const childSvc = createMockService<{
        id: number;
        uuid: string;
        created: string;
        updated: string;
      }>('integer');

      parentSvc.findById.mockResolvedValue({
        id: 1,
        name: 'p',
        created: 't',
        updated: 't',
      });
      childSvc.findById.mockResolvedValue({
        id: 10,
        created: 't',
        updated: 't',
      });
      junctionSvc.findAll.mockRejectedValue(new Error('DB boom'));

      const app = express();
      app.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...config,
        parentService: parentSvc,
        junctionService: junctionSvc,
        childService: childSvc,
      });
      app.use('/api/parents', router);
      app.use(
        (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
          res.status(500).json({ errors: [{ code: 'INTERNAL_ERROR', message: err.message }] });
        },
      );

      const res = await request(app).put('/api/parents/1/children/10').send({});
      expect(res.status).toBe(500);
      expect(res.body.errors[0].message).toBe('DB boom');
    });
  });

  describe('linkVerb config option', () => {
    interface ChildEntity {
      id: number;
      uuid: string;
      name: string;
      created: string;
      updated: string;
    }

    let childService: jest.Mocked<IEntityService<ChildEntity>>;

    const childA: ChildEntity = {
      id: 10,
      uuid: 'c10',
      name: 'Child A',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
    };

    function buildLinkApp(verb: 'POST' | 'PUT'): Application {
      const testApp = express();
      testApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...config,
        parentService,
        junctionService,
        childService,
        linkVerb: verb,
      });
      testApp.use('/api/parents', router);
      return testApp;
    }

    beforeEach(() => {
      childService = createMockService<ChildEntity>('integer');
    });

    it('registers POST /:parentId/children/:childId when linkVerb is POST', async () => {
      parentService.findById.mockResolvedValue(parent);
      childService.findById.mockResolvedValue(childA);
      junctionService.findAll.mockResolvedValue([]);
      junctionService.create.mockResolvedValue({
        id: 5,
        parent_id: 1,
        child_id: 10,
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      });

      const linkApp = buildLinkApp('POST');
      const res = await request(linkApp).post('/api/parents/1/children/10');

      expect(res.status).toBe(201);
      expect(res.body).toEqual(childA);
      expect(junctionService.create).toHaveBeenCalledWith({
        parent_id: 1,
        child_id: 10,
      });
    });

    it('POST link is idempotent when junction already exists', async () => {
      parentService.findById.mockResolvedValue(parent);
      childService.findById.mockResolvedValue(childA);
      junctionService.findAll.mockResolvedValue([
        {
          id: 5,
          parent_id: 1,
          child_id: 10,
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        },
      ]);

      const linkApp = buildLinkApp('POST');
      const res = await request(linkApp).post('/api/parents/1/children/10');

      expect(res.status).toBe(201);
      expect(res.body).toEqual(childA);
      expect(junctionService.create).not.toHaveBeenCalled();
    });

    it('does NOT register PUT /:parentId/children/:childId when linkVerb is POST', async () => {
      const linkApp = buildLinkApp('POST');
      const res = await request(linkApp).put('/api/parents/1/children/10');
      expect(res.status).toBe(404);
    });

    it('defaults to PUT when linkVerb is omitted', async () => {
      parentService.findById.mockResolvedValue(parent);
      childService.findById.mockResolvedValue(childA);
      junctionService.findAll.mockResolvedValue([]);
      junctionService.create.mockResolvedValue({
        id: 5,
        parent_id: 1,
        child_id: 10,
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      });

      const testApp = express();
      testApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...config,
        parentService,
        junctionService,
        childService,
      });
      testApp.use('/api/parents', router);

      const res = await request(testApp).put('/api/parents/1/children/10');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /:parentId/children/:childId (resolve via childService)', () => {
    interface ChildEntity {
      id: number;
      uuid: string;
      name: string;
      created: string;
      updated: string;
    }

    let childService: jest.Mocked<IEntityService<ChildEntity>>;

    const childA: ChildEntity = {
      id: 10,
      uuid: 'c10',
      name: 'Child A',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
    };

    function buildGetApp(): Application {
      const testApp = express();
      testApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...config,
        parentService,
        junctionService,
        childService,
      });
      testApp.use('/api/parents', router);
      return testApp;
    }

    beforeEach(() => {
      childService = createMockService<ChildEntity>('integer');
    });

    it('returns 200 with the resolved child when linked to this parent', async () => {
      parentService.findById.mockResolvedValue(parent);
      childService.findById.mockResolvedValue(childA);
      junctionService.findAll.mockResolvedValue([
        {
          id: 5,
          parent_id: 1,
          child_id: 10,
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        },
      ]);

      const res = await request(buildGetApp()).get('/api/parents/1/children/10');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(childA);
    });

    it('returns 404 when no junction exists for this parent/child pair', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockResolvedValue([]);

      const res = await request(buildGetApp()).get('/api/parents/1/children/10');

      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
    });

    it('returns 404 when child is linked to a different parent', async () => {
      parentService.findById.mockResolvedValue(parent);
      junctionService.findAll.mockResolvedValue([
        {
          id: 9,
          parent_id: 2,
          child_id: 10,
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        },
      ]);

      const res = await request(buildGetApp()).get('/api/parents/1/children/10');

      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
    });

    it('returns 404 when parent does not exist', async () => {
      parentService.findById.mockResolvedValue(null);

      const res = await request(buildGetApp()).get('/api/parents/999/children/10');

      expect(res.status).toBe(404);
      expect(res.body.errors[0].message).toContain('Parent');
    });

    it('returns 400 for invalid parentId', async () => {
      const res = await request(buildGetApp()).get('/api/parents/abc/children/10');
      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid childId', async () => {
      const res = await request(buildGetApp()).get('/api/parents/1/children/abc');
      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('does NOT register GET-by-id when childService is absent (settings mode)', async () => {
      const settingsApp = express();
      settingsApp.use(express.json());
      const router = Router();
      addNestedManyToManyRoutes(router, {
        ...config,
        parentService,
        junctionService,
      });
      settingsApp.use('/api/parents', router);

      const res = await request(settingsApp).get('/api/parents/1/children/10');
      expect(res.status).toBe(404);
    });
  });
});
