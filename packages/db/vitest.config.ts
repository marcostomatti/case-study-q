import { defineConfig } from 'vitest/config';

// Colocated suites only. The `*.test-d.ts` files next to each schema module
// are deliberately NOT matched here: they hold type-level assertions and are
// gated by `bun run check-types` instead, because the leaf tsconfig excludes
// `**/*.test.ts` and would read an `expectTypeOf` written in one as nothing
// at all. See the header of `src/schema/companies.test-d.ts`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
