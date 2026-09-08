import type { ServiceDatabase } from './database';
import type { UsageDatabase } from '../telemetry/usageLogger';
import type { ThrowawayDatabase } from '@marcos-corp/db/testing';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { expectTypeOf } from 'vitest';

/**
 * Type-level cases for the repository handle. Read by `bun run check-types`,
 * not by `bun run test`: the leaf tsconfig excludes `*.test.ts` and does not
 * exclude this suffix, and vitest never executes this file.
 *
 * The suites beside `database.ts` run every repository against a real
 * Postgres, so nothing here is about whether a query works. What they cannot
 * say is whether **one handle serves the whole service** — that `server.ts`
 * can build a single connection and hand it to the repositories and to the
 * usage logger without a cast, and that the handle the suites are given is the
 * same type as the one production uses. A suite that constructed its own
 * handle from a different call would still pass every case in this directory.
 */

/**
 * One handle for the whole service.
 *
 * `telemetry/usageLogger.ts` states a narrow `UsageDatabase` port rather than
 * naming a driver, which is right for it and leaves this open: if the two
 * drifted, `server.ts` would need two connections or a cast. This is the line
 * that keeps them together, and it is the reason `database.ts` picks
 * `NodePgDatabase`'s default schema parameter rather than a wider one.
 */
expectTypeOf<ServiceDatabase>().toExtend<UsageDatabase>();

/**
 * The handle the suites here are handed is the handle the repositories take.
 *
 * `@marcos-corp/db/testing` hands back a `NodePgDatabase` built by
 * `drizzle({ client: pool })`. Assignability in this direction is what makes
 * the database-backed suites evidence about the production path: were the two
 * merely compatible enough to compile after a widening, the suites would be
 * exercising a shape `server.ts` never produces.
 */
expectTypeOf<ThrowawayDatabase['db']>().toExtend<ServiceDatabase>();

/**
 * Pinned literally, so the schema parameter is a decision rather than whatever
 * the default happens to be after a Drizzle upgrade. A schema-bearing handle
 * would be a different type and would carry the relational query API this
 * layer deliberately does not use.
 */
expectTypeOf<ServiceDatabase>().toEqualTypeOf<NodePgDatabase<Record<string, never>>>();
