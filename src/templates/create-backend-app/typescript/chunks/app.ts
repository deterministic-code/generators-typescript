import { createBackendApp as createDeterministicApp } from "{{appImport}}";
import type { Express } from "express";
import { resolve } from "node:path";
import { access } from "node:fs/promises";

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

// === BEGIN APP_DB_IMPORTS — see PATCH_PLAN in create-migrate-scripts.mjs ===
// === END APP_DB_IMPORTS ===

export async function {{appFnName}}(): Promise<Express> {
  return createDeterministicApp({
    deterministicRoot: await resolveDeterministicRoot(),
    srcRoot: process.env.SRC_ROOT ?? process.cwd(),
    // === BEGIN APP_CUSTOM_MODULE_PATHS ===
    // === END APP_CUSTOM_MODULE_PATHS ===
    // === BEGIN APP_BEFORE_HOOK — see PATCH_PLAN in create-migrate-scripts.mjs ===
    // === END APP_BEFORE_HOOK ===
    // === BEGIN APP_AFTER_HOOK — see PATCH_PLAN in create-migrate-scripts.mjs ===
    // === END APP_AFTER_HOOK ===
  });
}
