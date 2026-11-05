import { q, normalizeDialect } from "./generate-sql.ts";
import type { SqlDialect } from "./generate-sql.ts";

export function requireDialect(dialect: string): SqlDialect {
  const key = normalizeDialect(dialect);
  if (!key) {
    throw new Error(
      `Unknown SQL dialect "${dialect}". Valid: sqlite, mysql, postgres, sqlserver, oracle.`,
    );
  }
  return key;
}

export function setupSql(dialect: string): string[] {
  const key = requireDialect(dialect);
  switch (key) {
    case "sqlite":
      return [sqliteMigratesDdl(), sqliteMigrateLogsDdl()];
    case "postgres":
      return [postgresMigratesDdl(), postgresMigrateLogsDdl()];
    case "mysql":
      return [mysqlMigratesDdl(), mysqlMigrateLogsDdl()];
    case "sqlserver":
      return [sqlserverMigratesDdl(), sqlserverMigrateLogsDdl()];
    case "oracle":
      return [oracleMigratesDdl(), oracleMigrateLogsDdl()];
    default:
      throw new Error(`Unhandled dialect: ${key}`);
  }
}

function sqliteMigratesDdl(): string {
  return `CREATE TABLE IF NOT EXISTS ${q("sqlite", "migrates")} (
  ${q("sqlite", "id")} INTEGER PRIMARY KEY AUTOINCREMENT,
  ${q("sqlite", "name")} VARCHAR(255) NOT NULL UNIQUE,
  ${q("sqlite", "checksum")} VARCHAR(64),
  ${q("sqlite", "created")} DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ${q("sqlite", "updated")} DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);`;
}
function sqliteMigrateLogsDdl(): string {
  return `CREATE TABLE IF NOT EXISTS ${q("sqlite", "migrate_logs")} (
  ${q("sqlite", "id")} INTEGER PRIMARY KEY AUTOINCREMENT,
  ${q("sqlite", "migrate_name")} VARCHAR(255) NOT NULL,
  ${q("sqlite", "direction")} VARCHAR(8) NOT NULL,
  ${q("sqlite", "status")} VARCHAR(16) NOT NULL,
  ${q("sqlite", "finished_at")} DATETIME,
  ${q("sqlite", "duration_ms")} INTEGER,
  ${q("sqlite", "error_message")} TEXT,
  ${q("sqlite", "created")} DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ${q("sqlite", "updated")} DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);`;
}

function postgresMigratesDdl(): string {
  return `CREATE TABLE IF NOT EXISTS ${q("postgres", "migrates")} (
  ${q("postgres", "id")} BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ${q("postgres", "name")} VARCHAR(255) NOT NULL UNIQUE,
  ${q("postgres", "checksum")} VARCHAR(64),
  ${q("postgres", "created")} TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ${q("postgres", "updated")} TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;
}
function postgresMigrateLogsDdl(): string {
  return `CREATE TABLE IF NOT EXISTS ${q("postgres", "migrate_logs")} (
  ${q("postgres", "id")} BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ${q("postgres", "migrate_name")} VARCHAR(255) NOT NULL,
  ${q("postgres", "direction")} VARCHAR(8) NOT NULL,
  ${q("postgres", "status")} VARCHAR(16) NOT NULL,
  ${q("postgres", "finished_at")} TIMESTAMPTZ,
  ${q("postgres", "duration_ms")} INTEGER,
  ${q("postgres", "error_message")} TEXT,
  ${q("postgres", "created")} TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ${q("postgres", "updated")} TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;
}

function mysqlMigratesDdl(): string {
  return `CREATE TABLE IF NOT EXISTS ${q("mysql", "migrates")} (
  ${q("mysql", "id")} BIGINT AUTO_INCREMENT PRIMARY KEY,
  ${q("mysql", "name")} VARCHAR(255) NOT NULL UNIQUE,
  ${q("mysql", "checksum")} VARCHAR(64),
  ${q("mysql", "created")} TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ${q("mysql", "updated")} TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);`;
}
function mysqlMigrateLogsDdl(): string {
  return `CREATE TABLE IF NOT EXISTS ${q("mysql", "migrate_logs")} (
  ${q("mysql", "id")} BIGINT AUTO_INCREMENT PRIMARY KEY,
  ${q("mysql", "migrate_name")} VARCHAR(255) NOT NULL,
  ${q("mysql", "direction")} VARCHAR(8) NOT NULL,
  ${q("mysql", "status")} VARCHAR(16) NOT NULL,
  ${q("mysql", "finished_at")} TIMESTAMP NULL,
  ${q("mysql", "duration_ms")} INT,
  ${q("mysql", "error_message")} TEXT,
  ${q("mysql", "created")} TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ${q("mysql", "updated")} TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);`;
}

function sqlserverMigratesDdl(): string {
  return `IF OBJECT_ID('dbo.migrates', 'U') IS NULL
CREATE TABLE ${q("sqlserver", "migrates")} (
  ${q("sqlserver", "id")} BIGINT IDENTITY(1,1) PRIMARY KEY,
  ${q("sqlserver", "name")} NVARCHAR(255) NOT NULL UNIQUE,
  ${q("sqlserver", "checksum")} NVARCHAR(64),
  ${q("sqlserver", "created")} DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  ${q("sqlserver", "updated")} DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);`;
}
function sqlserverMigrateLogsDdl(): string {
  return `IF OBJECT_ID('dbo.migrate_logs', 'U') IS NULL
CREATE TABLE ${q("sqlserver", "migrate_logs")} (
  ${q("sqlserver", "id")} BIGINT IDENTITY(1,1) PRIMARY KEY,
  ${q("sqlserver", "migrate_name")} NVARCHAR(255) NOT NULL,
  ${q("sqlserver", "direction")} NVARCHAR(8) NOT NULL,
  ${q("sqlserver", "status")} NVARCHAR(16) NOT NULL,
  ${q("sqlserver", "finished_at")} DATETIME2,
  ${q("sqlserver", "duration_ms")} INT,
  ${q("sqlserver", "error_message")} NVARCHAR(MAX),
  ${q("sqlserver", "created")} DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  ${q("sqlserver", "updated")} DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);`;
}

function oracleMigratesDdl(): string {
  return `BEGIN
  EXECUTE IMMEDIATE 'CREATE TABLE ${q("oracle", "migrates")} (
    ${q("oracle", "id")} NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${q("oracle", "name")} VARCHAR2(255) NOT NULL UNIQUE,
    ${q("oracle", "checksum")} VARCHAR2(64),
    ${q("oracle", "created")} TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ${q("oracle", "updated")} TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
END;`;
}
function oracleMigrateLogsDdl(): string {
  return `BEGIN
  EXECUTE IMMEDIATE 'CREATE TABLE ${q("oracle", "migrate_logs")} (
    ${q("oracle", "id")} NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${q("oracle", "migrate_name")} VARCHAR2(255) NOT NULL,
    ${q("oracle", "direction")} VARCHAR2(8) NOT NULL,
    ${q("oracle", "status")} VARCHAR2(16) NOT NULL,
    ${q("oracle", "finished_at")} TIMESTAMP,
    ${q("oracle", "duration_ms")} NUMBER(10),
    ${q("oracle", "error_message")} CLOB,
    ${q("oracle", "created")} TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ${q("oracle", "updated")} TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
END;`;
}
