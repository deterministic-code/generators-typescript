import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from 'express';
import type { CrudRouteSpec } from '../loaders/parseCrudRouteSpecs';
import type { DatabaseConnection } from '../../repositories';
import * as repoModule from '../../repositories';

// captures every createCrudRouter({...}) call made during createBackendApp boot
const createCrudRouterSpy = vi.fn((..._args: unknown[]) => Router());

vi.mock('../../routes', async () => {
  const actual = await vi.importActual<typeof import('../../routes')>('../../routes');
  return { ...actual, createCrudRouter: createCrudRouterSpy };
});

const { createBackendApp } = await import('../createBackendApp');

const CUSTOM_PK_SPEC: CrudRouteSpec = {
  pathSegment: 'legacy-contacts',
  entityName: 'legacy_contact',
  columns: ['key', 'first_name', 'last_name'],
  primaryKeyColumn: 'key',
  primaryKeyIdType: 'string',
};

const INT_PK_SPEC: CrudRouteSpec = {
  pathSegment: 'widgets',
  entityName: 'widget',
  primaryKeyColumn: 'id',
  primaryKeyIdType: 'integer',
  columns: ['name'],
};

function fakeRepo(options: { entityName: string; primaryKeys: repoModule.IPrimaryKeyService }) {
  return {
    entityName: options.entityName,
    primaryKey: options.primaryKeys.forEntity(options.entityName),
    query: vi.fn(),
    find: vi.fn(),
    findAll: vi.fn(),
    findBy: vi.fn(),
    findIn: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as ReturnType<typeof repoModule.buildRepoForBackend>;
}

function bootWithSpec(spec: CrudRouteSpec) {
  const conn = {
    type: 'memory',
    close: () => Promise.resolve(),
  } as unknown as DatabaseConnection;
  return createBackendApp(conn, {
    backendAppConfig: { middleware: [], handlers: [], statics: [] },
    settingsConfig: { pluralizeTableNames: true },
    routeSpecs: [],
    serviceSpecs: [],
    crudSpecs: [spec],
    datasourceData: { types: [] } as never,
    routesData: { routes: [] } as never,
    viewTypesDoc: { types: [] } as never,
  });
}

describe('createBackendApp — primaryKey wiring for custom-PK entities (regression for createBackendApp.ts:993)', () => {
  beforeEach(() => {
    createCrudRouterSpy.mockClear();
    vi.spyOn(repoModule, 'buildRepoForBackend').mockImplementation(((
      _conn: DatabaseConnection,
      _table: string,
      options: { entityName: string; primaryKeys: repoModule.IPrimaryKeyService },
    ) => fakeRepo(options)) as unknown as typeof repoModule.buildRepoForBackend);
  });

  it('resolves spec.primaryKey → service.primaryKey → createCrudRouter with the declared column + id type', async () => {
    // failure-mode: drop the injected primary key → router mounts /:id instead of /:key, every PATCH /api/legacy-contacts/<key> 404s
    await bootWithSpec(CUSTOM_PK_SPEC);

    const call = createCrudRouterSpy.mock.calls.find(
      ([opts]) => (opts as { entityName?: string }).entityName === 'legacy_contact',
    );
    expect(call, 'createCrudRouter not invoked for legacy_contact').toBeDefined();
    const opts = call![0] as { service: { primaryKey: { column: unknown; idType: unknown } } };
    expect(opts.service.primaryKey.column).toBe('key');
    expect(opts.service.primaryKey.idType).toBe('string');
  });

  it('resolves the implicit id column + project integer id type for default-PK entities', async () => {
    // why: contract — a default-PK spec resolves to the implicit `id` column with the project id_type, leaving the /:id route intact
    await bootWithSpec(INT_PK_SPEC);

    const call = createCrudRouterSpy.mock.calls.find(
      ([opts]) => (opts as { entityName?: string }).entityName === 'widget',
    );
    expect(call, 'createCrudRouter not invoked for widget').toBeDefined();
    const opts = call![0] as { service: { primaryKey: { column: unknown; idType: unknown } } };
    expect(opts.service.primaryKey.column).toBe('id');
    expect(opts.service.primaryKey.idType).toBe('integer');
  });
});
