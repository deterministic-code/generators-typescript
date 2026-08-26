import { describe, it, beforeEach, vi } from 'vitest';
import { expect } from 'vitest';
import type { Express } from 'express';
import type { DatabaseConnection } from '../../repositories';
import type { IEntityService } from '../../services/interfaces/IEntityService';
import { createBackendApp } from '../createBackendApp';
import { PrimaryKey } from '../../repositories/PrimaryKey';
import * as repoModule from '../../repositories';

interface MockDb extends DatabaseConnection {
  tables: Record<
    string,
    Array<{
      id: number;
      [key: string]: unknown;
    }>
  >;
}

function createMockConnection(): MockDb {
  const conn: MockDb = {
    type: 'memory',
    tables: {},
    query: async () => ({ rows: [] }),
    exec: async () => undefined,
    close: async () => undefined,
    middlewares: [],
  } as unknown as MockDb;
  return conn;
}

function createMockService<
  T extends { id: number; uuid: string; created: string; updated: string },
>(): jest.Mocked<IEntityService<T, any>> {
  return {
    entityName: 'mock',
    primaryKey: new PrimaryKey('id', 'integer'),
    query: jest.fn().mockResolvedValue([]),
    findById: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    findAll: jest.fn().mockResolvedValue([]),
    findBy: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    updateBy: jest.fn(),
    deleteBy: jest.fn(),
  } as unknown as jest.Mocked<IEntityService<T, any>>;
}

describe('createBackendApp with eager_load', () => {
  let app: Express;
  let mockConn: MockDb;

  beforeEach(async () => {
    mockConn = createMockConnection();

    const mockRepos: Record<string, IEntityService<any, any>> = {
      applicationService: createMockService(),
      application_settingService: createMockService(),
    };

    vi.spyOn(repoModule, 'buildRepoForBackend').mockImplementation(
      (_conn: any, entityName: string) => {
        const key = `${entityName}Service`;
        return (mockRepos[key] || createMockService()) as any;
      },
    );

    const backendAppConfig = {
      name: 'test',
      middleware: [],
      handlers: [],
      statics: [],
    };

    const datasourceData: any = {
      types: [
        {
          application: {
            datasource_type: 'crud',
            fields: [{ id: { type: 'number', is_unique: true } }],
          },
        },
        {
          application_setting: {
            datasource_type: 'crud',
            fields: [
              { id: { type: 'number', is_unique: true } },
              { application_id: { type: 'number', references: 'application.id' } },
            ],
          },
        },
      ],
    };

    const routesData: any = {
      includes: [
        {
          view_type_routes: {
            eager_path: ['application.settings'],
          },
        },
      ],
      routes: [
        {
          get_application: {
            path: '/api/applications/:id',
            method: 'GET',
            response: 'application',
          },
        },
        {
          create_backend_application: {
            path: '/api/applications',
            method: 'POST',
            request: 'application',
            response: 'application',
          },
        },
      ],
    };

    const crudSpecs = [
      {
        entityName: 'application',
        pathSegment: 'applications',
        primaryKeyColumn: 'id',
        primaryKeyIdType: 'integer' as const,
        columns: ['id'],
        readonly: false,
        m2m: false,
        nestedOnly: false,
      },
      {
        entityName: 'application_setting',
        pathSegment: 'application_settings',
        primaryKeyColumn: 'id',
        primaryKeyIdType: 'integer' as const,
        columns: ['id', 'application_id'],
        readonly: false,
        m2m: false,
        nestedOnly: false,
      },
    ];

    const routeSpecs: any = [];
    const serviceSpecs: any = [];

    const viewTypesDoc = {
      types: [
        {
          application: {
            inherits: 'datasource_types.application',
            fields: [
              {
                settings: {
                  type: 'datasource_types.application_setting[]',
                  references: 'datasource_types.application_setting.application_id',
                },
              },
            ],
          },
        },
        {
          application_setting: {
            inherits: 'datasource_types.application_setting',
            fields: [],
          },
        },
      ],
    };

    app = await createBackendApp(mockConn, {
      backendAppConfig,
      datasourceData,
      routesData,
      crudSpecs,
      routeSpecs,
      serviceSpecs,
      viewTypesDoc,
      viewTypesAutoEnrich: false,
      settingsConfig: { pluralizeTableNames: true },
    });
  });

  it('boots without error', async () => {
    expect(app).toBeDefined();
    expect(typeof app.use).toBe('function');
  });
});
