/**
 * A migrated, seeded Postgres for the suites under `src/repositories/`.
 *
 * The repository layer is the one part of this service whose claims cannot be
 * made without a database. A fake that answers `select().from(cards)` is a
 * second implementation of Drizzle that agrees with the suite and with nothing
 * else — it cannot tell anyone whether the `WHERE` clause scopes by company,
 * whether `ORDER BY booked_at DESC` reaches the index, or whether an
 * `UPDATE ... RETURNING` guarded on a lifecycle state actually refuses a second
 * activation. Those are the claims, so the suites run against the real thing.
 *
 * The server comes from `@marcos-corp/db/testing`, which either connects to a
 * `TEST_DATABASE_URL` that was deliberately provided or stands a private
 * cluster up on a unix socket. Neither available is one pointed error from
 * `beforeAll` and skipped cases rather than a green run — the same argument
 * `@marcos-corp/contract-tooling` makes for shelling out to the real `vacuum`.
 *
 * Test support, deliberately **not** re-exported from `src/index.ts`: nothing
 * a consumer of this package installs should reach a module that opens
 * database connections. It lives under `src/` rather than beside the suites so
 * `bun run check-types` and `bun run lint` both read it — the leaf tsconfig
 * excludes `*.test.ts` and this is not one.
 */
import type { ServiceDatabase } from '../repositories/database';
import type { ThrowawayDatabase, ThrowawayPostgres } from '@marcos-corp/db/testing';

import { seedDatabase } from '@marcos-corp/db/seed';
import {
  MIGRATIONS_DIR,
  startThrowawayPostgres,
  THROWAWAY_POSTGRES_TIMEOUT_MS,
} from '@marcos-corp/db/testing';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/**
 * The instant every seeded row is measured back from.
 *
 * Fixed, so `period_started_at`, every `booked_at` and both invoice due dates
 * are the same on every run and a case may compare against a literal. The
 * suites here pass the same value wherever a repository takes an `asOf` or an
 * `activatedAt`, which is what keeps a window boundary case from depending on
 * when the suite happened to run.
 */
export const SEED_NOW = new Date('2026-09-08T12:00:00.000Z');

/** `initdb`, the migrations and the seed are seconds, not milliseconds. */
export const SEEDED_DATABASE_TIMEOUT_MS = THROWAWAY_POSTGRES_TIMEOUT_MS;

export interface SeededPostgres {
  /** A migrated database carrying `packages/db`'s seed. */
  readonly db: ServiceDatabase;
  /**
   * Another migrated database on the same server, with **no** rows.
   *
   * What every "returns null / returns an empty page" case needs. Asserting an
   * absence against the seeded database only says the seed does not happen to
   * contain the row; asserting it against an empty one, beside a positive
   * control on the seeded one, is what says the query looked.
   */
  createEmptyDatabase(): Promise<ServiceDatabase>;
  /** Drops every database created here and stops a private cluster. */
  stop(): Promise<void>;
}

async function migrated(database: ThrowawayDatabase): Promise<ServiceDatabase> {
  await migrate(database.db, { migrationsFolder: MIGRATIONS_DIR });
  return database.db;
}

/**
 * Starts a server, migrates a database into it and runs `packages/db`'s seed.
 *
 * Call in a `beforeAll` with `SEEDED_DATABASE_TIMEOUT_MS`, and `stop()` in the
 * matching `afterAll`.
 */
export async function startSeededDatabase(now: Date = SEED_NOW): Promise<SeededPostgres> {
  const postgres: ThrowawayPostgres = await startThrowawayPostgres();
  const db = await migrated(await postgres.createDatabase());
  await seedDatabase(db, { now });

  return {
    db,
    createEmptyDatabase: async () => migrated(await postgres.createDatabase()),
    stop: () => postgres.stop(),
  };
}
