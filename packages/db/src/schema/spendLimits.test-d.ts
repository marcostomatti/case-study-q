import type { NewSpendLimit, SpendLimit, SpendLimitResetPeriod } from './spendLimits';

import { expectTypeOf } from 'vitest';

/**
 * Type-level cases for the `spend_limits` row types. See the header of
 * `companies.test-d.ts` for why these live in a `.test-d.ts` and which gate
 * reads them: `bun run check-types`, not `bun run test`.
 */

/**
 * Every column is `NOT NULL`, so nothing here is nullable — and the absence of
 * a `remaining` field is the case's real content. Remaining spend is
 * `capMinorUnits` minus the settled transactions in the window, computed by
 * `service-a`'s dashboard mapper; a column for it would be a second source of
 * truth that goes stale the moment a transaction settles. If one is ever added,
 * this expectation is what fails first.
 */
expectTypeOf<SpendLimit>().toEqualTypeOf<{
  cardId: string;
  capMinorUnits: number;
  resetPeriod: 'monthly' | 'quarterly' | 'annual';
  periodStartedAt: Date;
}>();

/**
 * Nothing is optional on insert, unlike every other table in this schema. The
 * table has no generated column: its key is the composite
 * `(card_id, reset_period, period_started_at)`, so all three parts have to be
 * supplied by the writer. A `.defaultRandom()` id or a `defaultNow()` on the
 * period start would show up here as an optional field, which is the drift this
 * case exists to catch.
 */
expectTypeOf<NewSpendLimit>().toEqualTypeOf<{
  cardId: string;
  capMinorUnits: number;
  resetPeriod: 'monthly' | 'quarterly' | 'annual';
  periodStartedAt: Date;
}>();

/**
 * The union a mapper switches over, stated separately because it is the type
 * `service-a` imports by name and an exhaustive `switch` is only exhaustive
 * against whatever this resolves to. No `unknown` member: that belongs to the
 * contract enum, not to a database one.
 */
expectTypeOf<SpendLimitResetPeriod>().toEqualTypeOf<'monthly' | 'quarterly' | 'annual'>();

/**
 * `capMinorUnits` is a `number`, not a `string`. Worth pinning: drizzle renders
 * `bigint` and `numeric` as `string` by default, so a column widened for the
 * overflow ceiling noted in `spendLimits.ts` — or "fixed" to `numeric` for
 * money — changes this type and every arithmetic site downstream. Money in this
 * repo is integer minor units, and this is the type-level half of that rule.
 */
expectTypeOf<SpendLimit['capMinorUnits']>().toEqualTypeOf<number>();
