import type { UsageDatabase, UsageEvent, UsageSink } from './usageLogger';
import type { NewApiUsageEvent } from '@marcos-corp/db';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { expectTypeOf } from 'vitest';

/**
 * Type-level cases for the usage logger. Read by `bun run check-types`, not by
 * `bun run test`: the leaf tsconfig excludes `*.test.ts` and does not exclude
 * this file's suffix, and vitest never executes it.
 *
 * The claim they own is the one `usageLogger.test.ts` cannot make. That suite
 * drives a real Drizzle database over a recording client, so it proves what a
 * statement *says*; nothing in it can fail when `UsageEvent` grows a field the
 * table has no column for, or when the port this module states drifts from the
 * driver `server.ts` will actually hand it.
 */

/**
 * The port is honest: the driver this service connects with satisfies it.
 *
 * Without this case `UsageDatabase` is a shape that agrees with the fake in the
 * runtime suite and with nothing else — a structural interface nobody checks
 * against the real thing is a mock with extra steps. Note the direction: the
 * real database must satisfy the port, never the reverse.
 */
expectTypeOf<NodePgDatabase<Record<string, never>>>().toExtend<UsageDatabase>();

/**
 * Every column `api_usage` requires is on the event.
 *
 * `NewApiUsageEvent` makes `id` optional (the database generates it) and every
 * other column required, so this assignability is exactly the statement "this
 * row can be inserted". A field dropped from `UsageEvent` fails here before it
 * reaches a runtime insert that Postgres would refuse.
 */
expectTypeOf<UsageEvent>().toExtend<NewApiUsageEvent>();

/**
 * Pinned literally rather than against `NewApiUsageEvent`, which would compare
 * the type against the thing it is checked for assignability to above and stay
 * green through a widening on either side.
 */
expectTypeOf<UsageEvent>().toEqualTypeOf<{
  readonly occurredAt: Date;
  readonly clientId: string;
  readonly operationId: string;
  readonly contractVersion: string;
  readonly responseStatusCode: number;
  readonly consumerPackageName: string;
}>();

/**
 * A sink may be synchronous or asynchronous, and the middleware awaits either.
 * A recorder in a suite is the first shape; `apiUsageSink` is the second.
 */
expectTypeOf<(event: UsageEvent) => void>().toExtend<UsageSink>();
expectTypeOf<(event: UsageEvent) => Promise<void>>().toExtend<UsageSink>();
