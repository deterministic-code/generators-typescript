import { createBackendApp as createDeterministicApp } from "{{libImport}}";
import type { Express } from "express";
import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { composeRouter } from "{{composeRouterImport}}";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveDeterministicRoot(): Promise<string> {
  if (process.env.DETERMINISTIC_ROOT) return process.env.DETERMINISTIC_ROOT;
  let cur = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(cur, "deterministic");
    if (await fileExists(candidate)) return candidate;
    cur = resolve(cur, "..");
  }
  return resolve(process.cwd(), "deterministic");
}

{{APP_DB_IMPORTS_START}}
{{APP_DB_IMPORTS_END}}

export async function createBackendApp(): Promise<Express> {
  return createDeterministicApp({
    deterministicRoot: await resolveDeterministicRoot(),
    srcRoot: process.env.SRC_ROOT ?? process.cwd(),
    routeComposer: composeRouter,{{APP_CUSTOM_MODULE_PATHS}}
    {{APP_BEFORE_HOOK_START}}
    {{APP_BEFORE_HOOK_END}}
    {{APP_AFTER_HOOK_START}}
    {{APP_AFTER_HOOK_END}}
  });
}
