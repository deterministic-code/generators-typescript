import { describe, expect, it } from 'vitest';
import { parseGenericRouteSpecs, parseCustomRouteSpecs } from '../loaders/parseRouteSpecs';

describe('parseGenericRouteSpecs', () => {
  it('returns specs for valid entries', () => {
    const specs = parseGenericRouteSpecs({
      routes: [
        {
          getHealth: {
            path: '/api/healthcheck',
            method: 'GET',
            service: 'HealthCheckService',
            serviceMethod: 'check',
            responseFormat: 'item',
          },
        },
      ],
    });
    expect(specs).toEqual([
      {
        routeName: 'getHealth',
        path: '/api/healthcheck',
        method: 'GET',
        service: 'HealthCheckService',
        serviceMethod: 'check',
        responseFormat: 'item',
      },
    ]);
  });

  it('skips entries that lack a service field (e.g. CRUD entries)', () => {
    const specs = parseGenericRouteSpecs({
      routes: [
        { crudOnly: { path: '/api/users', method: 'GET' } },
        {
          getHealth: {
            path: '/api/healthcheck',
            method: 'GET',
            service: 'HealthCheckService',
            serviceMethod: 'check',
          },
        },
      ],
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].routeName).toBe('getHealth');
  });

  it('treats spec function: as serviceMethod (contacts migrate / import routes)', () => {
    const specs = parseGenericRouteSpecs({
      routes: [
        {
          migrate_legacy_contacts: {
            path: '/api/legacy-contacts/migrate',
            method: 'POST',
            service: 'LegacyMigrationService',
            function: 'migrate',
          },
        },
      ],
    });
    expect(specs).toEqual([
      {
        routeName: 'migrate_legacy_contacts',
        path: '/api/legacy-contacts/migrate',
        method: 'POST',
        service: 'LegacyMigrationService',
        serviceMethod: 'migrate',
      },
    ]);
  });

  it('prefers serviceMethod when both serviceMethod and function are set', () => {
    const specs = parseGenericRouteSpecs({
      routes: [
        {
          getHealth: {
            path: '/api/healthcheck',
            method: 'GET',
            service: 'HealthCheckService',
            serviceMethod: 'check',
            function: 'other',
          },
        },
      ],
    });
    expect(specs[0]?.serviceMethod).toBe('check');
  });

  it('skips entries that declare service but omit serviceMethod (consumer hand-wires them)', () => {
    const doc = {
      routes: [
        {
          newSigninSession: {
            path: '/api/sessions/new_signin',
            method: 'POST',
            service: 'NewSigninSessionService',
          },
        },
        {
          getHealth: {
            path: '/api/healthcheck',
            method: 'GET',
            service: 'HealthCheckService',
            serviceMethod: 'check',
          },
        },
      ],
    };
    const specs = parseGenericRouteSpecs(doc);
    expect(specs).toHaveLength(1);
    expect(specs[0].routeName).toBe('getHealth');
  });

  it('returns empty for missing routes key', () => {
    expect(parseGenericRouteSpecs({})).toEqual([]);
    expect(parseGenericRouteSpecs(null)).toEqual([]);
  });

  it('soft-skips entries that declare routeClass (custom routes go through parseCustomRouteSpecs)', () => {
    const specs = parseGenericRouteSpecs({
      routes: [
        {
          generate: {
            path: '/api/generate',
            method: 'POST',
            routeClass: 'GenerateRoute',
            module: './routes/custom/generate-route',
          },
        },
        {
          getHealth: {
            path: '/api/health',
            method: 'GET',
            service: 'HealthCheckService',
            serviceMethod: 'check',
          },
        },
      ],
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].routeName).toBe('getHealth');
  });

  it('rejects an unknown HTTP method', () => {
    expect(() =>
      parseGenericRouteSpecs({
        routes: [
          {
            badMethod: {
              path: '/x',
              method: 'TRACE',
              service: 'X',
              serviceMethod: 'y',
            },
          },
        ],
      }),
    ).toThrow();
  });
});

describe('parseCustomRouteSpecs', () => {
  it('returns specs for entries with routeClass + module', () => {
    const specs = parseCustomRouteSpecs({
      routes: [
        {
          generate: {
            path: '/api/generate',
            method: 'POST',
            routeClass: 'GenerateRoute',
            module: './routes/custom/generate-route',
            args: [{ kind: 'service', name: 'GenerateCodeService' }],
          },
        },
      ],
    });
    expect(specs).toEqual([
      {
        routeName: 'generate',
        path: '/api/generate',
        method: 'POST',
        routeClass: 'GenerateRoute',
        module: './routes/custom/generate-route',
        args: [{ kind: 'service', name: 'GenerateCodeService' }],
      },
    ]);
  });

  it('defaults args to an empty array when omitted', () => {
    const specs = parseCustomRouteSpecs({
      routes: [
        {
          generatePlan: {
            path: '/api/generate/plan',
            method: 'GET',
            routeClass: 'GeneratePlanRoute',
            module: './routes/custom/generate-plan-route',
          },
        },
      ],
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].args).toEqual([]);
  });

  it('skips entries without routeClass (handled by generic parser)', () => {
    const specs = parseCustomRouteSpecs({
      routes: [
        {
          getHealth: {
            path: '/api/health',
            method: 'GET',
            service: 'HealthCheckService',
            serviceMethod: 'check',
          },
        },
      ],
    });
    expect(specs).toEqual([]);
  });

  it('requires module when routeClass is set', () => {
    expect(() =>
      parseCustomRouteSpecs({
        routes: [
          {
            broken: {
              path: '/api/broken',
              method: 'GET',
              routeClass: 'BrokenRoute',
            },
          },
        ],
      }),
    ).toThrow();
  });

  it('returns empty for missing routes key', () => {
    expect(parseCustomRouteSpecs({})).toEqual([]);
    expect(parseCustomRouteSpecs(null)).toEqual([]);
  });
});
