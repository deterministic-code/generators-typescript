async function resolveTestConnection(): Promise<DatabaseConnection> {
  // Dynamic imports keep this patched block self-contained — the unpatched generator default must compile without them.
  const { access } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const { connectDatabase } = await import("{{libImport}}");
  const backend = process.env.DATABASE_BACKEND ?? "sqlite";
  const dialect = backend === "memory" ? "sqlite" : backend;
  let migrationsDir: string | undefined;
  let cur = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(cur, "sql", dialect, "migrations");
    if (
      await access(candidate).then(
        () => true,
        () => false,
      )
    ) {
      migrationsDir = candidate;
      break;
    }
    cur = resolve(cur, "..");
  }
  if (!migrationsDir) {
    throw new Error(
      `sql/${dialect}/migrations not found — the test app migrates its database on connect; run the migrate_scripts step first.`,
    );
  }
  if (backend === "sqlite" || backend === "memory") {
    return await connectDatabase({ backend: "sqlite", migrationsDir });
  }
  if (
    backend !== "postgres" &&
    backend !== "mysql" &&
    backend !== "sqlserver" &&
    backend !== "oracle"
  ) {
    throw new Error(
      `DATABASE_BACKEND=${backend} is not a supported backend for the test app`,
    );
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      `DATABASE_BACKEND=${backend} requires DATABASE_URL so the test app can reach its database`,
    );
  }
  return await connectDatabase({ backend, databaseUrl, migrationsDir });
}
