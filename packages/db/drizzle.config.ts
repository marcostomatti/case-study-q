/**
 * Drizzle Kit configuration for `@marcos-corp/db`.
 *
 * `bun run db:generate` reads this file and writes SQL into `drizzle/`. The
 * migrations are generated, never hand-written — a hand-edited `.sql` file
 * drifts from `drizzle/meta/*_snapshot.json`, and the next `generate` then
 * emits a diff against a snapshot that describes a database nobody has.
 *
 * Two choices here are load-bearing rather than defaults:
 *
 *   - **`schema` points at `src/index.ts`, not at `src/schema/*.ts`.** The
 *     glob would also match the colocated `*.test.ts` and `*.test-d.ts`
 *     modules, which drizzle-kit would bundle and execute for their exports.
 *     `src/index.ts` is the package's declared surface and re-exports every
 *     table and enum, so "migrated" and "exported" stay the same set: a table
 *     nobody exports is a table no service can query.
 *   - **`dbCredentials.url` is read from the environment and is not needed by
 *     `generate`.** Generating a migration is a pure diff between the schema
 *     modules and the last snapshot; no database is contacted. The value is
 *     here for `drizzle-kit migrate`, which later tasks run against the
 *     Postgres in `docker/compose.yaml`. It carries no committed default on
 *     purpose — a fallback connection string is how a migration ends up
 *     applied to whatever database happened to be listening.
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
