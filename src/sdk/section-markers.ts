const PATCH_PLAN_HINT = "see PATCH_PLAN in create-migrate-scripts.mjs";

function tsBegin(id: string): string {
  return `// === BEGIN ${id} — ${PATCH_PLAN_HINT} ===`;
}

function tsEnd(id: string): string {
  return `// === END ${id} ===`;
}

function shBegin(id: string): string {
  return `# === BEGIN ${id} — ${PATCH_PLAN_HINT} ===`;
}

function shEnd(id: string): string {
  return `# === END ${id} ===`;
}

function xmlBegin(id: string): string {
  return `<!-- === BEGIN ${id} — ${PATCH_PLAN_HINT} === -->`;
}

function xmlEnd(id: string): string {
  return `<!-- === END ${id} === -->`;
}

function csBegin(id: string): string {
  return `// === BEGIN ${id} — ${PATCH_PLAN_HINT} ===`;
}

function csEnd(id: string): string {
  return `// === END ${id} ===`;
}

function rsBegin(id: string): string {
  return `// === BEGIN ${id} — ${PATCH_PLAN_HINT} ===`;
}

function rsEnd(id: string): string {
  return `// === END ${id} ===`;
}

interface SectionMarker {
  style: string;
  start: string;
  end: string;
}

/** Section IDs for every patched region create-migrate-scripts owns. Language-neutral so Rust/C# reuse the same labels. Every BEGIN marker carries a "see PATCH_PLAN..." reference so readers of generated files can find the contract. END markers stay short. */
export const SECTION_MARKERS = {
  APP_DB_IMPORTS: {
    style: "ts",
    start: tsBegin("APP_DB_IMPORTS"),
    end: tsEnd("APP_DB_IMPORTS"),
  },
  APP_BEFORE_HOOK: {
    style: "ts",
    start: tsBegin("APP_BEFORE_HOOK"),
    end: tsEnd("APP_BEFORE_HOOK"),
  },
  APP_AFTER_HOOK: {
    style: "ts",
    start: tsBegin("APP_AFTER_HOOK"),
    end: tsEnd("APP_AFTER_HOOK"),
  },
  TESTAPP_DB_CONN: {
    style: "ts",
    start: tsBegin("TESTAPP_DB_CONN"),
    end: tsEnd("TESTAPP_DB_CONN"),
  },
  MIGRATE_HOOK: {
    style: "sh",
    start: shBegin("MIGRATE_HOOK"),
    end: shEnd("MIGRATE_HOOK"),
  },
  APK_CLIENTS: {
    style: "sh",
    start: shBegin("APK_CLIENTS"),
    end: shEnd("APK_CLIENTS"),
  },
  MIGRATE_COPY: {
    style: "sh",
    start: shBegin("MIGRATE_COPY"),
    end: shEnd("MIGRATE_COPY"),
  },
  MIGRATE_RUNTIME_COPY: {
    style: "sh",
    start: shBegin("MIGRATE_RUNTIME_COPY"),
    end: shEnd("MIGRATE_RUNTIME_COPY"),
  },
  DIALECT_PACKAGES: {
    style: "xml",
    start: xmlBegin("DIALECT_PACKAGES"),
    end: xmlEnd("DIALECT_PACKAGES"),
  },
  MIGRATE_BIN: {
    style: "sh",
    start: shBegin("MIGRATE_BIN"),
    end: shEnd("MIGRATE_BIN"),
  },
  MIGRATE_DEPS: {
    style: "sh",
    start: shBegin("MIGRATE_DEPS"),
    end: shEnd("MIGRATE_DEPS"),
  },
  DIALECT_USINGS: {
    style: "cs",
    start: csBegin("DIALECT_USINGS"),
    end: csEnd("DIALECT_USINGS"),
  },
  DIALECT_DDL_CONSTS: {
    style: "cs",
    start: csBegin("DIALECT_DDL_CONSTS"),
    end: csEnd("DIALECT_DDL_CONSTS"),
  },
  DIALECT_SWITCH_ARMS: {
    style: "cs",
    start: csBegin("DIALECT_SWITCH_ARMS"),
    end: csEnd("DIALECT_SWITCH_ARMS"),
  },
  DIALECT_METHODS: {
    style: "cs",
    start: csBegin("DIALECT_METHODS"),
    end: csEnd("DIALECT_METHODS"),
  },
  DIALECT_SQLITE_PRECHECK: {
    style: "cs",
    start: csBegin("DIALECT_SQLITE_PRECHECK"),
    end: csEnd("DIALECT_SQLITE_PRECHECK"),
  },
  DIALECT_DISPATCH_ARMS: {
    style: "cs",
    start: csBegin("DIALECT_DISPATCH_ARMS"),
    end: csEnd("DIALECT_DISPATCH_ARMS"),
  },
  DIALECT_RUNNER_METHODS: {
    style: "cs",
    start: csBegin("DIALECT_RUNNER_METHODS"),
    end: csEnd("DIALECT_RUNNER_METHODS"),
  },
  DIALECT_ROLLBACK_METHODS: {
    style: "cs",
    start: csBegin("DIALECT_ROLLBACK_METHODS"),
    end: csEnd("DIALECT_ROLLBACK_METHODS"),
  },
  PERF_BIN: {
    style: "sh",
    start: shBegin("PERF_BIN"),
    end: shEnd("PERF_BIN"),
  },
  CUSTOM_SERVICES: {
    style: "rs",
    start: rsBegin("CUSTOM_SERVICES"),
    end: rsEnd("CUSTOM_SERVICES"),
  },
  MODULES: {
    style: "rs",
    start: rsBegin("MODULES"),
    end: rsEnd("MODULES"),
  },
  DIALECT_USE_IMPORTS_RUST: {
    style: "rs",
    start: rsBegin("DIALECT_USE_IMPORTS_RUST"),
    end: rsEnd("DIALECT_USE_IMPORTS_RUST"),
  },
  DIALECT_DDL_CONSTS_RUST: {
    style: "rs",
    start: rsBegin("DIALECT_DDL_CONSTS_RUST"),
    end: rsEnd("DIALECT_DDL_CONSTS_RUST"),
  },
  DIALECT_SETUP_DISPATCH_RUST: {
    style: "rs",
    start: rsBegin("DIALECT_SETUP_DISPATCH_RUST"),
    end: rsEnd("DIALECT_SETUP_DISPATCH_RUST"),
  },
  DIALECT_RUNNER_FNS_RUST: {
    style: "rs",
    start: rsBegin("DIALECT_RUNNER_FNS_RUST"),
    end: rsEnd("DIALECT_RUNNER_FNS_RUST"),
  },
  DIALECT_ROLLBACK_FNS_RUST: {
    style: "rs",
    start: rsBegin("DIALECT_ROLLBACK_FNS_RUST"),
    end: rsEnd("DIALECT_ROLLBACK_FNS_RUST"),
  },
  DIALECT_UP_DISPATCH_RUST: {
    style: "rs",
    start: rsBegin("DIALECT_UP_DISPATCH_RUST"),
    end: rsEnd("DIALECT_UP_DISPATCH_RUST"),
  },
  DIALECT_DOWN_DISPATCH_RUST: {
    style: "rs",
    start: rsBegin("DIALECT_DOWN_DISPATCH_RUST"),
    end: rsEnd("DIALECT_DOWN_DISPATCH_RUST"),
  },
  DIALECT_SQLITE_URL_HELPER_RUST: {
    style: "rs",
    start: rsBegin("DIALECT_SQLITE_URL_HELPER_RUST"),
    end: rsEnd("DIALECT_SQLITE_URL_HELPER_RUST"),
  },
} satisfies Record<string, SectionMarker>;
