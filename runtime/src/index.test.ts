import * as lib from './index';

describe('deterministic entry', () => {
  it('exports a non-empty version string', () => {
    expect(typeof lib.version).toBe('string');
    expect(lib.version.length).toBeGreaterThan(0);
  });

  it('exports error classes and helpers', () => {
    expect(lib.AppError).toBeDefined();
    expect(lib.NotFoundError).toBeDefined();
    expect(lib.ValidationError).toBeDefined();
    expect(lib.ConflictError).toBeDefined();
    expect(lib.BusinessError).toBeDefined();
    expect(lib.OAuthErrorCodes).toBeDefined();
    expect(typeof lib.handleBusinessError).toBe('function');
    expect(typeof lib.handleConstraintError).toBe('function');
    expect(typeof lib.handleZodError).toBe('function');
  });

  it('exports response helpers', () => {
    expect(typeof lib.sendItem).toBe('function');
    expect(typeof lib.sendItems).toBe('function');
    expect(typeof lib.sendSuccess).toBe('function');
    expect(typeof lib.sendError).toBe('function');
    expect(typeof lib.sendErrors).toBe('function');
  });

  it('exports middleware factories', () => {
    expect(typeof lib.authenticate).toBe('function');
    expect(typeof lib.authenticateSignin).toBe('function');
    expect(typeof lib.authorize).toBe('function');
    expect(typeof lib.derivePermission).toBe('function');
    expect(typeof lib.corsMiddleware).toBe('function');
    expect(typeof lib.errorHandler).toBe('function');
    expect(typeof lib.securityHeadersMiddleware).toBe('function');
    expect(typeof lib.jsonBodyMiddleware).toBe('function');
    expect(typeof lib.largeJsonBodyMiddleware).toBe('function');
    expect(typeof lib.formBodyMiddleware).toBe('function');
    expect(typeof lib.protectBuiltinRow).toBe('function');
    expect(typeof lib.validateBody).toBe('function');
    expect(typeof lib.validateParams).toBe('function');
    expect(lib.MiddlewareLookup).toBeDefined();
  });

  it('exports repositories and routes', () => {
    expect(lib.InMemoryCrudRepository).toBeDefined();
    expect(lib.SqliteSetup).toBeDefined();
    expect(lib.SqliteDatasource).toBeDefined();
    expect(lib.SqliteCrudRepository).toBeDefined();
    expect(lib.SqliteStandardRepository).toBeDefined();
    expect(lib.PostgresSetup).toBeDefined();
    expect(lib.PostgresDatasource).toBeDefined();
    expect(lib.PostgresCrudRepository).toBeDefined();
    expect(lib.PostgresStandardRepository).toBeDefined();
    expect(lib.MysqlSetup).toBeDefined();
    expect(lib.MysqlDatasource).toBeDefined();
    expect(lib.MysqlCrudRepository).toBeDefined();
    expect(lib.MysqlStandardRepository).toBeDefined();
    expect(lib.buildRepoForBackend).toBeDefined();
    expect(typeof lib.createCrudRouter).toBe('function');
    expect(typeof lib.createReadOnlyRouter).toBe('function');
    expect(typeof lib.addNestedManyToManyRoutes).toBe('function');
    expect(typeof lib.extractParam).toBe('function');
    expect(typeof lib.parsePositiveInt).toBe('function');
  });

  it('exports services and validators', () => {
    expect(lib.EntityService).toBeDefined();
    expect(lib.AuthenticationService).toBeDefined();
    expect(lib.LookupEnrichedService).toBeDefined();
    expect(typeof lib.parseBasicAuth).toBe('function');
  });
});
