/**
 * Reads on `spend_limits`: the cap behind `based on your set limit`, for the
 * window the screen is showing.
 *
 * What this module returns is the **cap and nothing else**, because that is
 * all the table holds. The `5 400` half of `5 400/10 000 kr` is not stored
 * anywhere and is not computed here either — `mapping/dashboardMapper.ts`
 * subtracts the settled spend, and `packages/db`'s `spend_limits` header
 * explains at length why a stored copy would be a second source of truth that
 * drifts the moment a transaction settles. A repository that helpfully
 * returned a `remaining` figure would be that copy, computed one query earlier.
 *
 * ## "Current" needs two things the table does not decide
 *
 * The primary key is `(card_id, reset_period, period_started_at)`, so a card
 * may hold several limits at once: a monthly one and an annual one, and one
 * row per window of each. Picking one is therefore a caller's decision in two
 * dimensions, and both are parameters rather than assumptions:
 *
 * - **Which reset period.** `DASHBOARD_RESET_PERIOD` below is the answer for
 *   the mobile view, typed as the database's own union so a member renamed in
 *   `spend_limit_reset_period` fails `bun run check-types` rather than silently
 *   matching nothing and reporting a company with no limit.
 * - **As of when.** A window that has not opened yet must not be returned, or
 *   a limit configured for next month replaces this month's the moment it is
 *   written. `asOf` is a parameter for the reason `activateCard` takes its
 *   instant and `packages/db`'s seed takes a `now`: a caller that fixes the
 *   clock gets a reproducible answer.
 *
 * There is no currency here, and that too is the table's decision rather than
 * an omission: a limit is denominated in the owning company's
 * `default_currency_code`, reached through the card, so that a card's cap can
 * never be denominated in a currency its transactions are not.
 */
import type { ServiceDatabase } from './database';
import type { SpendLimit, SpendLimitResetPeriod } from '@marcos-corp/db';

import { spendLimits } from '@marcos-corp/db';
import { and, desc, eq, lte } from 'drizzle-orm';

/** The newest window that has already opened is the current one. */
const ONE_ROW = 1;

/**
 * The reset period the mobile view's meter reads.
 *
 * Named here rather than written at the call site, because it is the same
 * product decision wherever it appears and reads as a magic string in all of
 * them. Typed as the database's union for the reason the module header gives —
 * the same guard `dashboardMapper`'s `COUNTED_SETTLEMENT_STATE` uses.
 */
export const DASHBOARD_RESET_PERIOD: SpendLimitResetPeriod = 'monthly';

/** Which card's limit, of which kind, at which moment. */
export interface SpendLimitLookup {
  readonly cardId: string;
  readonly resetPeriod: SpendLimitResetPeriod;
  /** Windows opening after this instant are ignored. See the module header. */
  readonly asOf: Date;
}

/**
 * The card's limit for the window in force at `asOf`, or `null` when it has
 * none.
 *
 * `null` is an ordinary answer rather than a fault: a card issued before any
 * limit was configured has no row here, and the route decides what the screen
 * says about it. Same split as every other read in this layer.
 *
 * The comparison is `<=`, so a window counts from the instant it opens. That
 * matches `dashboardMapper`'s inclusive window boundary for transactions —
 * both sides of `booked_at >= period_started_at` have to agree about the edge,
 * and the two are read together on every dashboard request.
 */
export async function findCurrentSpendLimit(
  db: ServiceDatabase,
  lookup: SpendLimitLookup,
): Promise<SpendLimit | null> {
  const rows = await db
    .select()
    .from(spendLimits)
    .where(and(
      eq(spendLimits.cardId, lookup.cardId),
      eq(spendLimits.resetPeriod, lookup.resetPeriod),
      lte(spendLimits.periodStartedAt, lookup.asOf),
    ))
    .orderBy(desc(spendLimits.periodStartedAt))
    .limit(ONE_ROW);

  return rows[0] ?? null;
}
