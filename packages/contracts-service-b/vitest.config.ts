import { defineConfig } from 'vitest/config';

// Colocated suites only. `bun run test` currently passes with no test files
// (see the --passWithNoTests flag in package.json); drop that flag in the
// task that adds this package's first suite.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
