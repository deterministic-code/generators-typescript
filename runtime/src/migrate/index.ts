/** Subpath entry for `deterministic/migrate` — re-exports the canonical migrate runtime (datasource-migrate.ts) which vite bundles into dist/migrate.js for tarball consumers (fixes #670 ERR_PACKAGE_PATH_NOT_EXPORTED on docker_up). */
export * from "./datasource-migrate";
