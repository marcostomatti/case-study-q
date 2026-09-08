import { configDefaults, defineConfig } from 'vitest/config';

// Colocated suites only, including `src/gates.integration.test.ts`.
//
// `bun run test` here requires BOTH documented prerequisite binaries on PATH
// (or `$VACUUM_BIN` / `$OASDIFF_BIN` pointing at them): `src/lint.test.ts` and
// `src/emit.test.ts` shell out to the real vacuum, `src/diff.test.ts` to the
// real oasdiff, and the gate-runner integration test to both. Stubbing either
// was rejected on purpose — a stub proves a suite parses its own fixtures,
// not that the house rules fire or that oasdiff classifies an edit the way the
// governance story claims.
// `*.gate.test.ts` is EXCLUDED here and runs under `bun run test:gates`.
// Those suites shell out to the real vacuum and oasdiff, so collecting them
// here would make this package's `test` script require two binaries to be
// installed — and this script is the one that must be green on a bare
// checkout with nothing but `bun install`.
export default defineConfig({
  test: {
    environment: 'node',
    exclude: [...configDefaults.exclude, '**/*.gate.test.ts'],
    include: ['src/**/*.test.ts'],
  },
});
