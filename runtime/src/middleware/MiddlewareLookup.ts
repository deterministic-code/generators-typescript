import type { RequestHandler, ErrorRequestHandler } from 'express';
import type { ZodSchema } from 'zod';
import type { IAuthenticationService } from '../services/IAuthenticationService';
import type { IAuthorizationService } from '../services/IAuthorizationService';
import type { IEntityService } from '../services/interfaces/IEntityService';

import { authenticate } from './authenticate';
import { authenticateSignin } from './authenticateSignin';
import { authorize } from './authorize';
import { corsMiddleware } from './corsMiddleware';
import { errorHandler } from './errorHandler';
import { securityHeadersMiddleware } from './securityHeadersMiddleware';
import { jsonBodyMiddleware } from './jsonBodyMiddleware';
import { largeJsonBodyMiddleware } from './largeJsonBodyMiddleware';
import { protectBuiltinRow } from './protectBuiltinRow';
import { formBodyMiddleware } from './formBodyMiddleware';
import { traceRouteMiddleware } from './traceRouteMiddleware';
import { validateBody, validateParams } from './validateRequest';

/**
 * Shared dependencies a {@link MiddlewareLookup} instance needs in order to
 * construct middleware that require services or secrets at call time.
 */
export interface MiddlewareDeps {
  /** Required by `get("authenticate")`. */
  authService?: IAuthenticationService;
  /** Required by `get("authorize")`. */
  authorizationService?: IAuthorizationService;
  /** Required by `get("authenticateSignin")` — HMAC/JWT secret. */
  jwtSecret?: string;
}

/** Union of regular and error-handling Express middleware shapes. */
export type MiddlewareHandler = RequestHandler | ErrorRequestHandler;

/**
 * Factory a consumer registers for a custom route-tier middleware name that
 * isn't built in. Called once per `get()` for that name, with the same `deps`
 * the lookup was constructed with.
 */
export type RouteMiddlewareFactory = (
  deps: MiddlewareDeps,
  ...args: unknown[]
) => MiddlewareHandler;

/**
 * Single registry that resolves middleware by name. Useful when building an
 * app.ts from a YAML manifest or similar data-driven pipeline — the middleware
 * factories keep their types, `get()` throws early when a required dep is
 * missing, and the keys are string-typed so they round-trip through config.
 *
 * Consumers can extend the registry without modifying the library by passing
 * a `factories` map: `new MiddlewareLookup(deps, { myCheck: () => handler })`.
 * Built-in names take precedence over factory names with the same key.
 */
export class MiddlewareLookup {
  constructor(
    private readonly deps: MiddlewareDeps = {},
    private readonly factories: Record<string, RouteMiddlewareFactory> = {},
  ) {}

  get(key: 'authenticate'): RequestHandler;
  get(key: 'authenticateSignin'): RequestHandler;
  get(key: 'authorize'): RequestHandler;
  get(key: 'cors'): RequestHandler;
  get(key: 'errorHandler'): ErrorRequestHandler;
  get(key: 'securityHeaders'): RequestHandler;
  get(key: 'jsonBody'): RequestHandler;
  get(key: 'largeJsonBody'): RequestHandler;
  get(key: 'formBody'): RequestHandler;
  get(key: 'traceRoute'): RequestHandler;
  get(key: 'validateBody', schema: ZodSchema): RequestHandler;
  get(key: 'validateParams', schema: ZodSchema): RequestHandler;
  get<
    T extends {
      id: number;
      uuid: string;
      created: string;
      updated: string;
      is_builtin: boolean;
      name: string;
    },
  >(key: 'protectBuiltinRow', service: IEntityService<T>, entityName: string): RequestHandler;
  get(key: string, ...args: unknown[]): MiddlewareHandler;
  get(key: string, ...args: unknown[]): MiddlewareHandler {
    switch (key) {
      case 'authenticate': {
        return authenticate(this.deps.authService!);
      }
      case 'authenticateSignin': {
        return authenticateSignin(this.deps.jwtSecret ?? '');
      }
      case 'authorize': {
        return authorize(this.deps.authorizationService!);
      }
      case 'cors': {
        return corsMiddleware;
      }
      case 'errorHandler': {
        return errorHandler;
      }
      case 'securityHeaders': {
        return securityHeadersMiddleware;
      }
      case 'jsonBody': {
        return jsonBodyMiddleware;
      }
      case 'largeJsonBody': {
        return largeJsonBodyMiddleware;
      }
      case 'formBody': {
        return formBodyMiddleware;
      }
      case 'traceRoute': {
        return traceRouteMiddleware;
      }
      case 'validateBody': {
        const schema = args[0] as ZodSchema | undefined;
        if (!schema) {
          throw new Error('validateBody requires a ZodSchema argument');
        }
        return validateBody(schema);
      }
      case 'validateParams': {
        const schema = args[0] as ZodSchema | undefined;
        if (!schema) {
          throw new Error('validateParams requires a ZodSchema argument');
        }
        return validateParams(schema);
      }
      case 'protectBuiltinRow': {
        const service = args[0] as
          | IEntityService<{
              id: number;
              uuid: string;
              created: string;
              updated: string;
              is_builtin: boolean;
              name: string;
            }>
          | undefined;
        const entityName = args[1] as string | undefined;
        if (!service || !entityName) {
          throw new Error('protectBuiltinRow requires (service, entityName) arguments');
        }
        return protectBuiltinRow(service, entityName);
      }
      default: {
        const factory = this.factories[key];
        if (factory) return factory(this.deps, ...args);
        throw new Error(`Unknown middleware key: ${key}`);
      }
    }
  }
}
