import type { RequestHandler } from 'express';
import { z } from 'zod';
import { MiddlewareLookup, type RouteMiddlewareFactory } from '../middleware/MiddlewareLookup';
import type { IAuthenticationService } from '../services/IAuthenticationService';
import type { IAuthorizationService } from '../services/IAuthorizationService';
import type { IEntityService } from '../services/interfaces/IEntityService';

describe('MiddlewareLookup', () => {
  it('returns authenticate when authService is provided', () => {
    const authService: IAuthenticationService = {
      authenticate: vi.fn(),
    };
    const lookup = new MiddlewareLookup({ authService });
    expect(typeof lookup.get('authenticate')).toBe('function');
  });

  it('returns authenticate without authService — dep validated lazily at request time', () => {
    const lookup = new MiddlewareLookup();
    expect(typeof lookup.get('authenticate')).toBe('function');
  });

  it('returns authenticateSignin when jwtSecret is provided', () => {
    const lookup = new MiddlewareLookup({ jwtSecret: 'x' });
    expect(typeof lookup.get('authenticateSignin')).toBe('function');
  });

  it('returns authenticateSignin without jwtSecret — dep validated lazily at request time', () => {
    const lookup = new MiddlewareLookup();
    expect(typeof lookup.get('authenticateSignin')).toBe('function');
  });

  it('returns authorize when authorizationService is provided', () => {
    const authorizationService: IAuthorizationService = {
      canAccessPermission: vi.fn(),
    };
    const lookup = new MiddlewareLookup({ authorizationService });
    expect(typeof lookup.get('authorize')).toBe('function');
  });

  it('returns authorize without authorizationService — dep validated lazily at request time', () => {
    const lookup = new MiddlewareLookup();
    expect(typeof lookup.get('authorize')).toBe('function');
  });

  it('returns built-in middleware without deps', () => {
    const lookup = new MiddlewareLookup();
    expect(typeof lookup.get('cors')).toBe('function');
    expect(typeof lookup.get('errorHandler')).toBe('function');
    expect(typeof lookup.get('securityHeaders')).toBe('function');
    expect(typeof lookup.get('jsonBody')).toBe('function');
    expect(typeof lookup.get('formBody')).toBe('function');
  });

  it('returns validateBody when given a schema', () => {
    const lookup = new MiddlewareLookup();
    const schema = z.object({ a: z.string() });
    expect(typeof lookup.get('validateBody', schema)).toBe('function');
  });

  it('throws for validateBody without a schema', () => {
    const lookup = new MiddlewareLookup();
    expect(() => lookup.get('validateBody')).toThrow(/validateBody requires a ZodSchema argument/);
  });

  it('returns validateParams when given a schema', () => {
    const lookup = new MiddlewareLookup();
    const schema = z.object({ id: z.string() });
    expect(typeof lookup.get('validateParams', schema)).toBe('function');
  });

  it('throws for validateParams without a schema', () => {
    const lookup = new MiddlewareLookup();
    expect(() => lookup.get('validateParams')).toThrow(
      /validateParams requires a ZodSchema argument/,
    );
  });

  it('returns protectBuiltinRow when service and entityName given', () => {
    const service = {
      findById: vi.fn(),
    } as unknown as IEntityService<{
      id: number;
      uuid: string;
      created: string;
      updated: string;
      is_builtin: boolean;
      name: string;
    }>;
    const lookup = new MiddlewareLookup();
    expect(typeof lookup.get('protectBuiltinRow', service, 'Scope')).toBe('function');
  });

  it('throws for protectBuiltinRow without service', () => {
    const lookup = new MiddlewareLookup();
    expect(() => lookup.get('protectBuiltinRow')).toThrow(
      /protectBuiltinRow requires \(service, entityName\)/,
    );
  });

  it('throws for protectBuiltinRow without entityName', () => {
    const service = {
      findById: vi.fn(),
    } as unknown as IEntityService<{
      id: number;
      uuid: string;
      created: string;
      updated: string;
      is_builtin: boolean;
      name: string;
    }>;
    const lookup = new MiddlewareLookup();
    expect(() => lookup.get('protectBuiltinRow', service)).toThrow(
      /protectBuiltinRow requires \(service, entityName\)/,
    );
  });

  it('throws for unknown keys', () => {
    const lookup = new MiddlewareLookup();
    expect(() => lookup.get('nope')).toThrow(/Unknown middleware key: nope/);
  });

  test('factory contributes a fresh name and forwards extra args after deps', () => {
    const myHandler = ((_req, _res, next) => next()) as RequestHandler;
    const factory = vi.fn((_deps, ...args) => {
      expect(args).toEqual(['extra']);
      return myHandler;
    });
    const deps = { jwtSecret: 'shh' };
    const lookup = new MiddlewareLookup(deps, { myCheck: factory });
    expect(lookup.get('myCheck', 'extra')).toBe(myHandler);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(deps, 'extra');
  });

  test("built-in 'cors' wins over a 'cors' factory with the same key", () => {
    const corsFactory = vi.fn();
    const lookup = new MiddlewareLookup(
      {},
      { cors: corsFactory as unknown as RouteMiddlewareFactory },
    );
    expect(typeof lookup.get('cors')).toBe('function');
    expect(corsFactory).not.toHaveBeenCalled();
  });

  test("regression: lookup.get('totally-unknown') still throws Unknown middleware key with no factories", () => {
    const lookup = new MiddlewareLookup();
    expect(() => lookup.get('totally-unknown')).toThrow(/Unknown middleware key: totally-unknown/);
  });
});
