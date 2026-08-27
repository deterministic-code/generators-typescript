import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

const runtimeDeps = [
  'better-sqlite3',
  'cors',
  'express',
  'helmet',
  'js-yaml',
  'jsonwebtoken',
  'mssql',
  'mysql2',
  'mysql2/promise',
  'oracledb',
  'pg',
  'pluralize',
  'zod',
];

const entries: Record<string, string> = {
  index: 'src/index.ts',
  errors: 'src/errors/index.ts',
  responses: 'src/responses/index.ts',
  middleware: 'src/middleware/index.ts',
  repositories: 'src/repositories/index.ts',
  'repositories/sqlserver': 'src/repositories/sqlserver/index.ts',
  'repositories/oracle': 'src/repositories/oracle/index.ts',
  routes: 'src/routes/index.ts',
  services: 'src/services/index.ts',
  app: 'src/app/index.ts',
  validators: 'src/validators/index.ts',
  converters: 'src/converters/index.ts',
  migrate: 'src/migrate/index.ts',
};

export default defineConfig({
  build: {
    lib: {
      entry: Object.fromEntries(
        Object.entries(entries).map(([name, path]) => [name, resolve(__dirname, path)]),
      ),
      name: 'DeterministicBackend',
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => (format === 'es' ? `${entryName}.js` : `${entryName}.cjs`),
    },
    sourcemap: true,
    rollupOptions: {
      external: [
        /^node:/,
        /^@deterministic-code\/generators-common/,
        ...runtimeDeps,
        'fs',
        'path',
        'crypto',
        'os',
        'url',
        'util',
      ],
    },
  },
  plugins: [
    dts({
      include: ['src'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
      rollupTypes: true,
    }),
  ],
});
