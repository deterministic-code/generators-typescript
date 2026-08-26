import { defineConfig } from 'vitest/config';

const FULL = { statements: 100, branches: 100, functions: 100, lines: 100 };

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'src/**/*.functional.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'lcov', 'html'],
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/**/*.d.ts',
        'src/test-setup.ts',
        'src/services/interfaces/**',
        'src/services/IAuthenticationService.ts',
        'src/services/IAuthorizationService.ts',
        'src/services/ISigninService.ts',
        'src/services/AuthCallbackResult.ts',
        'src/services/EntityMeta.ts',
        'src/repositories/IRepository.ts',
      ],
      thresholds: {
        lines: 84,
        branches: 91,
        functions: 81,
        statements: 84,
        '**/routes/iterateCombinedRoutes.ts': FULL,
        '**/services/EagerChildWritingService.ts': FULL,
        '**/services/EntityService.ts': FULL,
      },
    },
  },
});
