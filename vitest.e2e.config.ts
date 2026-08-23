import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      LEADOPS_ENCRYPTION_KEY: process.env.LEADOPS_ENCRYPTION_KEY ?? '0000000000000000000000000000000000000000000000000000000000000000',
    },
    globals: true,
    include: ['**/*.e2e.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    globalSetup: ['./packages/db/src/test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
