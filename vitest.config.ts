import { defineConfig } from 'vitest/config';

// Root config covers tools/ (the ralph loop). Package suites run through
// their own configs via `bun run test:all`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tools/**/*.test.ts'],
  },
});
