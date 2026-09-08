#!/usr/bin/env bun

/**
 * Applies the committed Drizzle migrations to the database `DATABASE_URL`
 * names.
 *
 *   DATABASE_URL=postgres://... bun run --filter @marcos-corp/db db:migrate
 *
 * Drizzle's `migrate` is used rather than piping the SQL through `psql`,
 * because it also writes the journal table — so a second run is a no-op rather
 * than a pile of "relation already exists" errors, and the demo script can be
 * re-run against a stack that is already up.
 *
 * The test suites do not call this: `startThrowawayPostgres` migrates its own
 * throwaway database. This entrypoint exists for the compose stack, where the
 * database outlives the process that migrates it.
 */

import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { MIGRATIONS_DIR } from './testing/throwawayDatabase';

/** Exit code for a missing or unusable `DATABASE_URL`, distinct from a failure. */
const EXIT_NO_DATABASE_URL = 2;

function describeError(error: unknown): string {
  if (error instanceof Error) {
    // `pg` reports a refused connection as an AggregateError whose own message
    // is empty, so the cause is the only place the reason is written down.
    const cause = error.cause;
    if (!error.message && cause instanceof Error) return cause.message;
    return error.message || String(error);
  }
  return String(error);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('[db:migrate] FAIL — DATABASE_URL is not set.');
    process.exit(EXIT_NO_DATABASE_URL);
  }

  const pool = new Pool({ connectionString });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: MIGRATIONS_DIR });
    console.log(`[db:migrate] OK — migrations in ${MIGRATIONS_DIR} applied.`);
  } catch (error) {
    console.error(`[db:migrate] FAIL — ${describeError(error)}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Runs only when invoked directly, never when imported. `import.meta.url` is a
// file:// URL and `process.argv[1]` is a plain path, so the comparison needs the
// conversion — without it the guard is always false and the CLI does nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
