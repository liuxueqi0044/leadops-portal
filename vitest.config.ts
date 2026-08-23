import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@leadops\/core$/, replacement: resolve('packages/core/src/index.ts') },
      { find: /^@leadops\/db$/, replacement: resolve('packages/db/src/index.ts') },
      { find: /^@leadops\/db\/client$/, replacement: resolve('packages/db/src/client.ts') },
      { find: /^@leadops\/email$/, replacement: resolve('packages/email/src/index.ts') },
      { find: /^@leadops\/events$/, replacement: resolve('packages/events/src/index.ts') },
      {
        find: /^@leadops\/observability$/,
        replacement: resolve('packages/observability/src/index.ts'),
      },
    ],
  },
  test: {
    globals: true,
    include: ['**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/*.db.test.ts',
      '**/*.integration.test.ts',
      '**/*.e2e.test.ts',
    ],
  },
});
