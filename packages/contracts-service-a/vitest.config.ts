import { defineConfig } from 'vitest/config';

// Colocated suites only. `*.test.ts` is what runs here; the `*.test-d.ts`
// siblings beside each schema module are type-level and are read by
// `bun run check-types` instead, since the leaf tsconfig excludes `**/*.test.ts`
// and that glob does not match them.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
