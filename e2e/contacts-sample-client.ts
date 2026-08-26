import assert from "node:assert/strict";
import { createCasing } from "../src/common/default-casing.ts";
import {
  asRecord,
  itemsOf,
  loadFetchClient,
  uniqueSuffix,
  type BindingClient,
  type FetchHttp,
} from "./fullstack-sample-client.ts";

export {
  asRecord,
  itemsOf,
  loadFetchClient,
  uniqueSuffix,
  type BindingClient,
  type FetchHttp,
};

export const clientFileBase = (
  entity: string,
  settings: Record<string, string>,
): string => createCasing(settings).fileBase(entity);

export const ifMatchHeaders = (
  updated: unknown,
): Record<string, string> => {
  assert.equal(typeof updated, "string");
  return { "If-Match": updated as string };
};

export const loadEntityClient = async (
  appDir: string,
  entity: string,
  baseUrl: string,
  settings: Record<string, string>,
): Promise<{ http: FetchHttp; client: BindingClient }> =>
  loadFetchClient(
    appDir,
    clientFileBase(entity, settings),
    baseUrl,
    settings,
    entity,
  );
