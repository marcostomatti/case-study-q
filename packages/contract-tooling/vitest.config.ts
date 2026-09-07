import { defineConfig } from 'vitest/config';

// Colocated suites only. `src/lint.test.ts` shells out to the real `vacuum`
// binary, so `bun run test` here requires the documented prerequisite to be
// on PATH (or $VACUUM_BIN to point at it) — a stubbed vacuum would prove the
// suite parses its own fixtures rather than that the house rules fire.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
