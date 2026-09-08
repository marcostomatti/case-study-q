import { defineConfig } from 'vitest/config';

// Colocated suites only. `*.test.ts` is what runs here; the `*.test-d.ts`
// siblings beside each schema module are type-level and are read by
// `bun run check-types` instead, since the leaf tsconfig excludes `**/*.test.ts`
// and that glob does not match them.
//
// `scripts/` is included for the same colocation reason: `scripts/emit.ts` is
// gate 1 for this package and the suite that keeps the committed
// `openapi/openapi.json` from going stale re-emits through its exports, so it
// belongs beside it. Without this glob that suite is collected by nothing and
// a stale artifact ships green.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
