import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCasing } from "../src/common/default-casing.ts";

export type FetchHttp = {
  request: <T>(input: {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
  }) => Promise<T>;
};

export type BindingClient = Record<
  string,
  (...args: unknown[]) => Promise<unknown>
>;

export const asRecord = (value: unknown): Record<string, unknown> => {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
};

export const itemsOf = (body: unknown): unknown[] => {
  if (Array.isArray(body)) return body;
  const rec = asRecord(body);
  assert.ok(Array.isArray(rec.items), "expected { items: [] }");
  return rec.items;
};

export const loadFetchClient = async (
  appDir: string,
  fileBase: string,
  baseUrl: string,
  settings: Record<string, string> = {},
  entityName: string = fileBase,
): Promise<{ http: FetchHttp; client: BindingClient }> => {
  const dir = join(appDir, "frontend/src/client/fetch");
  const httpMod = (await import(pathToFileURL(join(dir, "http.ts")).href)) as {
    createHttp: (baseUrl: string) => FetchHttp;
  };
  const entityMod = (await import(
    pathToFileURL(join(dir, `${fileBase}.ts`)).href
  )) as Record<string, (http: FetchHttp) => BindingClient>;
  const factoryName = createCasing(settings).clientName(entityName);
  const factory = entityMod[factoryName];
  assert.equal(typeof factory, "function", `missing ${factoryName}`);
  const http = httpMod.createHttp(baseUrl);
  return { http, client: factory(http) };
};

export const uniqueSuffix = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
