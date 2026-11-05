    beforeCreateBackendApp: async () => {
      const backend = (process.env.DATABASE_BACKEND ?? "sqlite") as SupportedBackend;
      const dbPath = process.env.DB_PATH ?? ":memory:";
      const databaseUrl = process.env.DATABASE_URL;
      const willMigrate = process.env.DETERMINISTIC_APP_MIGRATE === "1";
      // When auto-migrating, a missing sqlite file is fine — migration creates the schema (e.g. the perf-server boots a fresh temp DB). Only guard when the caller expects a pre-migrated file.
      if (backend === "sqlite" && dbPath !== ":memory:" && !willMigrate && !(await fileExists(dbPath))) {
        throw new Error(
          `sqlite database file not found at "${dbPath}". ` +
          `Run \`npm run migrate:setup\` and \`npm run migrate\` to create it.`,
        );
      }
      if (backend !== "sqlite" && backend !== "memory" && !databaseUrl) {
        throw new Error(
          `${backend} backend requires DATABASE_URL to be set (e.g. postgresql://user:pass@host:port/db)`,
        );
      }
      const migrationsDir = willMigrate
        ? await resolveMigrationsDir(backend)
        : undefined;
      const connection = await connectDatabase(
        backend === "sqlite" || backend === "memory"
          ? { backend, sqliteFile: dbPath, migrationsDir }
          : { backend, databaseUrl: databaseUrl!, migrationsDir },
      );
      return { connection };
    },
    enableMiddleware: parseEnableMiddlewareEnv(process.env.DETERMINISTIC_TRACE),
