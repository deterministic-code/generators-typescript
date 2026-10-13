import * as errors from '../errors';
import * as responses from '../responses';
import * as middleware from '../middleware';
import * as identity from '../identity';
import * as routes from '../routes';
import * as services from '../services';
import * as validators from '../validators';
import * as sqlIdentifier from '../sqlIdentifier';

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

  it('identity barrel exposes EntityIdentity and PrimaryKey', () => {
    expect(identity.EntityIdentity).toBeDefined();
    expect(identity.PrimaryKey).toBeDefined();
  });

  it('routes barrel exposes router factories and param utils', () => {
    expect(typeof routes.createCrudRouter).toBe('function');
    expect(typeof routes.createReadOnlyRouter).toBe('function');
    expect(typeof routes.addNestedManyToManyRoutes).toBe('function');
    expect(typeof routes.extractParam).toBe('function');
    expect(typeof routes.parsePositiveInt).toBe('function');
  });

  it('services barrel exposes service classes', () => {
    expect(services.DelegatingEntityService).toBeDefined();
    expect(services.AuthenticationService).toBeDefined();
  });

  it('validators barrel exposes parseBasicAuth', () => {
    expect(typeof validators.parseBasicAuth).toBe('function');
  });

  it('sqlIdentifier exports quote helpers', () => {
    expect(typeof sqlIdentifier.quoteIdentifier).toBe('function');
    expect(typeof sqlIdentifier.assertValidIdentifier).toBe('function');
  });
});
