const SQL_DIALECTS = [
  "sqlite",
  "mysql",
  "postgres",
  "sqlserver",
  "oracle",
] as const;

export type SqlDialect = (typeof SQL_DIALECTS)[number];

const ALIASES: Record<string, SqlDialect> = {
  sqlite: "sqlite",
  mysql: "mysql",
  postgres: "postgres",
  postgresql: "postgres",
  sqlserver: "sqlserver",
  mssql: "sqlserver",
  oracle: "oracle",
};

const QUOTES: Record<SqlDialect, readonly [string, string]> = {
  sqlite: ['"', '"'],
  mysql: ["`", "`"],
  postgres: ['"', '"'],
  sqlserver: ["[", "]"],
  oracle: ['"', '"'],
};

export const normalizeDialect = (dialect: string): SqlDialect | undefined =>
  ALIASES[dialect.trim().toLowerCase()];

export const q = (dialect: string, ident: string): string => {
  const key = normalizeDialect(dialect);
  const [left, right] = key !== undefined ? QUOTES[key] : (['"', '"'] as const);
  return `${left}${ident}${right}`;
};
