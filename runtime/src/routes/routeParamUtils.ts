import type { Response } from 'express';
import type { EntityIdentity, IdentityValue } from '../repositories/EntityIdentity';
import { sendError } from '../responses/sendResponse';

/**
 * Safely extracts a route parameter as a string.
 * Express 5 types define params values as string | string[].
 */
export function extractParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Parses a string as a positive integer.
 * Returns the parsed number or null if invalid (NaN, zero, or negative).
 */
export function parsePositiveInt(raw: string | undefined): number | null {
  const id = parseInt(raw ?? '', 10);
  if (isNaN(id) || id <= 0) return null;
  return id;
}

/**
 * Kind of primary key an entity declares, driving `/:id` (and nested
 * `/:parentId`) param parsing. `integer` keeps the parseInt-then-positive
 * contract; `uuid` validates the canonical 36-char form; `string` accepts any
 * non-empty trimmed value (the DB lookup is the backstop). Shared by the flat
 * CRUD router and the nested/​m2m routers so a uuid project validates path ids
 * the same way at every depth.
 */
export type RouteIdType = 'integer' | 'string' | 'uuid';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRouteId(idType: RouteIdType, raw: string | undefined): number | string | null {
  const value = extractParam(raw) ?? '';
  if (idType === 'integer') return parsePositiveInt(value);
  if (idType === 'uuid') return UUID_RE.test(value) ? value : null;
  return value.length > 0 ? value : null;
}

/** The `must be …` clause for a rejected id path param, matched to its id_type. */
export function idTypeConstraint(idType: RouteIdType): string {
  if (idType === 'integer') return 'must be a positive integer';
  if (idType === 'uuid') return 'must be a valid uuid';
  return 'must be a non-empty string';
}

export type ParsedId = { id: IdentityValue } | { error: string };

/** Parse a path id param for `idType`, returning the value or a `field`-labelled validation message — shared by the flat, nested, and m2m routers so id parsing lives one place. */
export function parseIdField(
  idType: RouteIdType,
  field: string,
  raw: string | undefined,
): ParsedId {
  const id = parseRouteId(idType, raw);
  if (id === null) return { error: `${field}: ${idTypeConstraint(idType)}` };
  return { id };
}

/** Parse every identity column from `params` (one segment each). */
export function parseIdentityField(
  identity: EntityIdentity,
  params: Record<string, string | string[] | undefined>,
): ParsedId {
  if (!identity.isComposite) {
    const key = identity.keys[0]!;
    return parseIdField(key.routeIdType, key.column, extractParam(params[key.column]));
  }
  const rec: Record<string, number | string> = {};
  for (const key of identity.keys) {
    const parsed = parseIdField(key.routeIdType, key.column, extractParam(params[key.column]));
    if ('error' in parsed) return parsed;
    rec[key.column] = parsed.id as number | string;
  }
  return { id: rec };
}

/** Unwrap a {@link ParsedId}: the id, or null after sending the 400 for its validation message. */
export function idOr400(res: Response, parsed: ParsedId): IdentityValue | null {
  if ('error' in parsed) {
    sendError(res, 400, 'VALIDATION_ERROR', parsed.error);
    return null;
  }
  return parsed.id;
}
