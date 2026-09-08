import { defineConfig } from 'vitest/config';

// The gate suites: `*.gate.test.ts`, run by `bun run test:gates`.
//
// These require BOTH prerequisite binaries on PATH (or `$VACUUM_BIN` /
// `$OASDIFF_BIN` pointing at them). Stubbing either was rejected on purpose —
// a stub proves a suite parses its own fixtures, not that the house rules fire
// or that oasdiff classifies an edit the way the governance story claims.
//
// They are separated from `bun run test` so the hygiene suite stays green on a
// bare checkout. The split is by FILENAME rather than by a runtime skip: a
// skipped suite cannot be told apart from a broken one, whereas a file this
// config never collects is unambiguous.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.gate.test.ts'],
  },
});
