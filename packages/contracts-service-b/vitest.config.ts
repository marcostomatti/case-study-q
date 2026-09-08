import { defineConfig } from 'vitest/config';

// Colocated suites only. The `--passWithNoTests` flag this package was created
// with is gone: from the first suite on, a leaf whose tests vanish must go red
// rather than green.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
