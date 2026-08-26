import { z } from 'zod';
import type { ArgSpec } from '../services/types';

const genericRouteSchema = z.object({
  routeName: z.string().min(1),
  path: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  service: z.string().min(1),
  serviceMethod: z.string().min(1),
  responseFormat: z.enum(['item', 'items', 'raw']).optional(),
  statusCode: z.number().int().positive().optional(),
  aliases: z.array(z.string()).optional(),
});

export type GenericRouteSpec = z.infer<typeof genericRouteSchema>;

const argSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('repo'), name: z.string().min(1) }),
  z.object({ kind: z.literal('service'), name: z.string().min(1) }),
  z.object({ kind: z.literal('config'), key: z.string().min(1) }),
  z.object({ kind: z.literal('undefined') }),
  z.object({ kind: z.literal('literal'), value: z.unknown() }),
]);

const customRouteSchema = z.object({
  routeName: z.string().min(1),
  path: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  routeClass: z.string().min(1),
  module: z.string().min(1),
  args: z.array(argSpecSchema).optional(),
});

export interface CustomRouteSpec {
  routeName: string;
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  routeClass: string;
  module: string;
  args: ArgSpec[];
}

type RoutesDoc = { routes?: Array<Record<string, unknown>> } | null;

function isFieldsMap(entry: unknown): entry is Record<string, unknown> {
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry);
}

export function parseGenericRouteSpecs(doc: unknown): GenericRouteSpec[] {
  const entries = ((doc as RoutesDoc)?.routes ?? []) as unknown[];
  const specs: GenericRouteSpec[] = [];
  for (const entry of entries) {
    // why string + `{name: null}` skip: bare-string byField shorthand (`widgets_by_key`) and the equivalent null-bodied map (`{widgets_by_key: null}`) are routed via parseCrudRouteSpecs.collectByFieldRoutes — not a generic route, so silently skip without dereferencing.
    if (typeof entry === 'string') continue;
    if (!isFieldsMap(entry)) continue;
    const pairs = Object.entries(entry);
    if (pairs.length !== 1) continue;
    const [routeName, fieldsRaw] = pairs[0];
    if (!isFieldsMap(fieldsRaw)) continue;
    const fields = fieldsRaw;
    if (typeof fields.routeClass === 'string') continue;
    if (typeof fields.service !== 'string') continue;
    const serviceMethod =
      typeof fields.serviceMethod === 'string'
        ? fields.serviceMethod
        : typeof fields.function === 'string'
          ? fields.function
          : undefined;
    // Soft-skip routes that declare service: but no method (`serviceMethod` or spec `function`) — they're hand-wired by the consumer (yaml entry kept only as OpenAPI metadata).
    if (serviceMethod === undefined) continue;
    specs.push(genericRouteSchema.parse({ routeName, ...fields, serviceMethod }));
  }
  return specs;
}

export function parseCustomRouteSpecs(doc: unknown): CustomRouteSpec[] {
  const entries = ((doc as RoutesDoc)?.routes ?? []) as unknown[];
  const specs: CustomRouteSpec[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') continue;
    if (!isFieldsMap(entry)) continue;
    const pairs = Object.entries(entry);
    if (pairs.length !== 1) continue;
    const [routeName, fieldsRaw] = pairs[0];
    if (!isFieldsMap(fieldsRaw)) continue;
    const fields = fieldsRaw;
    if (typeof fields.routeClass !== 'string') continue;
    const parsed = customRouteSchema.parse({ routeName, ...fields });
    specs.push({
      routeName: parsed.routeName,
      path: parsed.path,
      method: parsed.method,
      routeClass: parsed.routeClass,
      module: parsed.module,
      args: (parsed.args as ArgSpec[] | undefined) ?? [],
    });
  }
  return specs;
}
