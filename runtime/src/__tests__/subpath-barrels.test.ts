import * as errors from '../errors';
import * as responses from '../responses';
import * as middleware from '../middleware';
import * as repositories from '../repositories';
import * as repositoriesSqlserver from '../repositories/sqlserver';
import * as repositoriesOracle from '../repositories/oracle';
import * as routes from '../routes';
import * as services from '../services';
import * as validators from '../validators';
import * as converters from '../converters';

describe('subpath barrels', () => {
  it('errors barrel exposes error classes and helpers', () => {
    expect(errors.AppError).toBeDefined();
    expect(errors.NotFoundError).toBeDefined();
    expect(errors.ValidationError).toBeDefined();
    expect(errors.ConflictError).toBeDefined();
    expect(errors.BusinessError).toBeDefined();
    expect(errors.OAuthErrorCodes).toBeDefined();
    expect(typeof errors.handleBusinessError).toBe('function');
    expect(typeof errors.handleConstraintError).toBe('function');
    expect(typeof errors.handleZodError).toBe('function');
  });

  it('responses barrel exposes response helpers', () => {
    expect(typeof responses.sendItem).toBe('function');
    expect(typeof responses.sendItems).toBe('function');
    expect(typeof responses.sendSuccess).toBe('function');
    expect(typeof responses.sendError).toBe('function');
    expect(typeof responses.sendErrors).toBe('function');
  });

  it('middleware barrel exposes middleware factories and MiddlewareLookup', () => {
    expect(typeof middleware.authenticate).toBe('function');
    expect(typeof middleware.authenticateSignin).toBe('function');
    expect(typeof middleware.authorize).toBe('function');
    expect(typeof middleware.derivePermission).toBe('function');
    expect(typeof middleware.corsMiddleware).toBe('function');
    expect(typeof middleware.errorHandler).toBe('function');
    expect(typeof middleware.securityHeadersMiddleware).toBe('function');
    expect(typeof middleware.jsonBodyMiddleware).toBe('function');
    expect(typeof middleware.formBodyMiddleware).toBe('function');
    expect(typeof middleware.protectBuiltinRow).toBe('function');
    expect(typeof middleware.validateBody).toBe('function');
    expect(typeof middleware.validateParams).toBe('function');
    expect(middleware.MiddlewareLookup).toBeDefined();
  });

  it('repositories barrel exposes the layered classes for every backend', () => {
    expect(repositories.InMemoryCrudRepository).toBeDefined();
    expect(repositories.SqliteSetup).toBeDefined();
    expect(repositories.SqliteDatasource).toBeDefined();
    expect(repositories.SqliteCrudRepository).toBeDefined();
    expect(repositories.SqliteStandardRepository).toBeDefined();
    expect(repositories.PostgresSetup).toBeDefined();
    expect(repositories.PostgresDatasource).toBeDefined();
    expect(repositories.PostgresCrudRepository).toBeDefined();
    expect(repositories.PostgresStandardRepository).toBeDefined();
    expect(repositories.MysqlSetup).toBeDefined();
    expect(repositories.MysqlDatasource).toBeDefined();
    expect(repositories.MysqlCrudRepository).toBeDefined();
    expect(repositories.MysqlStandardRepository).toBeDefined();
    expect(repositories.buildRepoForBackend).toBeDefined();
  });

  it('repositories/sqlserver subpath exposes the sqlserver layered classes', () => {
    expect(repositoriesSqlserver.SqlserverSetup).toBeDefined();
    expect(repositoriesSqlserver.SqlserverDatasource).toBeDefined();
    expect(repositoriesSqlserver.SqlserverCrudRepository).toBeDefined();
    expect(repositoriesSqlserver.SqlserverStandardRepository).toBeDefined();
  });

  it('repositories/oracle subpath exposes the oracle layered classes', () => {
    expect(repositoriesOracle.OracleSetup).toBeDefined();
    expect(repositoriesOracle.OracleDatasource).toBeDefined();
    expect(repositoriesOracle.OracleCrudRepository).toBeDefined();
    expect(repositoriesOracle.OracleStandardRepository).toBeDefined();
  });

  it('routes barrel exposes router factories and param utils', () => {
    expect(typeof routes.createCrudRouter).toBe('function');
    expect(typeof routes.createReadOnlyRouter).toBe('function');
    expect(typeof routes.addNestedManyToManyRoutes).toBe('function');
    expect(typeof routes.extractParam).toBe('function');
    expect(typeof routes.parsePositiveInt).toBe('function');
  });

  it('services barrel exposes service classes', () => {
    expect(services.EntityService).toBeDefined();
    expect(services.AuthenticationService).toBeDefined();
    expect(services.LookupEnrichedService).toBeDefined();
  });

  it('validators barrel exposes parseBasicAuth', () => {
    expect(typeof validators.parseBasicAuth).toBe('function');
  });

  it('converters barrel exposes the SQLite -> TypeScript field converters', () => {
    expect(converters.booleanFieldConverter).toBeDefined();
    expect(converters.dateTimeFieldConverter).toBeDefined();
    expect(converters.binaryFieldConverter).toBeDefined();
    expect(converters.uuidFieldConverter).toBeDefined();
    expect(typeof converters.getDefaultConverters).toBe('function');
  });
});
