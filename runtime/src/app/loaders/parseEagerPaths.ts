import type { EagerLoadTree } from './computeEagerChildren';
import { routeViewTypeDirective } from './routeViewTypeDirective';

function insertEagerPath(entry: unknown, out: Map<string, EagerLoadTree>): void {
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new Error(`eager_path entries must be non-empty strings, got ${JSON.stringify(entry)}`);
  }
  const segments = entry.split('.');
  if (segments.length < 2) {
    throw new Error(
      `eager_path entry "${entry}" must contain at least one nested field (e.g. "user.posts")`,
    );
  }
  if (segments.some((s) => s.length === 0)) {
    throw new Error(`eager_path entry "${entry}" has an empty segment`);
  }
  const [root, ...rest] = segments;
  let node = out.get(root);
  if (!node) {
    node = new Map();
    out.set(root, node);
  }
  let cursor: EagerLoadTree = node;
  for (const seg of rest) {
    let next = cursor.get(seg);
    if (!next) {
      next = new Map();
      cursor.set(seg, next);
    }
    cursor = next;
  }
}

export function collectEntityEagerPaths(
  routesDoc: unknown,
  field: 'eager_read_path' | 'eager_update_path',
): string[] {
  const routes =
    routesDoc && typeof routesDoc === 'object' && Array.isArray((routesDoc as { routes?: unknown }).routes)
      ? ((routesDoc as { routes: unknown[] }).routes ?? [])
      : [];
  const out: string[] = [];
  for (const entry of routes) {
    if (!entry || typeof entry !== 'object') continue;
    const [entity, body] = Object.entries(entry)[0] ?? [];
    if (typeof entity !== 'string' || !body || typeof body !== 'object') continue;
    const list = (body as Record<string, unknown>)[field];
    if (!Array.isArray(list)) continue;
    for (const seg of list) {
      if (typeof seg === 'string' && seg.length > 0) out.push(`${entity}.${seg}`);
    }
  }
  return out;
}

export function parseEagerPaths(routesDoc: unknown): Map<string, EagerLoadTree> {
  const out = new Map<string, EagerLoadTree>();
  const raw = routeViewTypeDirective(routesDoc)?.eager_path;
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw)) {
      throw new Error(`eager_path must be an array of dotted paths, got ${typeof raw}`);
    }
    for (const entry of raw) insertEagerPath(entry, out);
  }
  for (const entry of collectEntityEagerPaths(routesDoc, 'eager_read_path')) {
    insertEagerPath(entry, out);
  }
  return out;
}

function eagerPathStrings(routesDoc: unknown): Set<string> {
  const raw = routeViewTypeDirective(routesDoc)?.eager_path;
  const out = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.length > 0) out.add(entry);
  }
  return out;
}

/** Dotted paths (e.g. "project.files") that are eager on member reads only — attached on GET /:id and mutation returns, skipped on the collection list. */
export function parseMemberOnlyReadPaths(routesDoc: unknown): Set<string> {
  const raw = routeViewTypeDirective(routesDoc)?.eager_read_member_only;
  const out = new Set<string>();
  if (raw === undefined || raw === null) return out;
  if (!Array.isArray(raw)) {
    throw new Error(`eager_read_member_only must be an array of dotted paths, got ${typeof raw}`);
  }
  const declared = eagerPathStrings(routesDoc);
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(
        `eager_read_member_only entries must be non-empty strings, got ${JSON.stringify(entry)}`,
      );
    }
    if (entry.split('.').length !== 2) {
      throw new Error(
        `eager_read_member_only entry "${entry}" must be depth-1 ("<view>.<arrayField>"); it governs a top-level entity's collection list`,
      );
    }
    if (!declared.has(entry)) {
      throw new Error(
        `eager_read_member_only entry "${entry}" is not in eager_path; it narrows an already-declared eager relation, it cannot introduce a new one`,
      );
    }
    out.add(entry);
  }
  return out;
}
