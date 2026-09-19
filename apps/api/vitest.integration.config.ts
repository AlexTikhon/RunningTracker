import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ['test/**/*.integration.test.ts'],
    pool: 'forks',
    testTimeout: 10_000,
  },
});

