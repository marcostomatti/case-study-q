import { defineConfig } from 'vitest/config';

// Colocated suites only. The `*.test-d.ts` files beside them are NOT collected
// here and are not meant to be: vitest never executes one, and `tsc` reads them
// because the leaf tsconfig's exclude covers `*.test.ts` and not that suffix.
// So `bun run test` gates behaviour and `bun run check-types` gates types.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
