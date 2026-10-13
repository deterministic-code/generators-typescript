import type { IncomingMessage, ServerResponse } from "node:http";

// === BEGIN APP_DB_IMPORTS — see PATCH_PLAN in create-migrate-scripts.mjs ===
// === END APP_DB_IMPORTS ===

export async function {{appFnName}}() {
  // === BEGIN APP_CUSTOM_MODULE_PATHS ===
  // === END APP_CUSTOM_MODULE_PATHS ===
  // === BEGIN APP_BEFORE_HOOK — see PATCH_PLAN in create-migrate-scripts.mjs ===
  // === END APP_BEFORE_HOOK ===
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === "GET" && path === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ {{statusField}}: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end();
  };
  // === BEGIN APP_AFTER_HOOK — see PATCH_PLAN in create-migrate-scripts.mjs ===
  // === END APP_AFTER_HOOK ===
  return handle;
}
