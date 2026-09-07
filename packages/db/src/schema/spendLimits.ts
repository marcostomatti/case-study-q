/**
 * The `spend_limits` table: the "based on your set limit" half of the
 * remaining-spend meter in the mobile view. The other half — the `5 400` — is
 * not stored anywhere.
 *
 * That asymmetry is the point, and it is the strongest example in this schema
 * of why spec §2.1 keeps the contract hand-authored:
 *
 *   - The contract publishes a **remaining** figure beside its limit. There is
 *     no `remaining` column here and there must not be one, because remaining
 *     spend is the cap minus the settled transactions in the period and a
 *     stored copy is a second source of truth that drifts the moment a
 *     transaction settles. `service-a`'s dashboard mapper computes it.
 *   - So a schema derived from this table could not produce the contract's
 *     payload at all. The mapping layer is not ceremony here; it is the only
 *     thing that can assemble the field the screen renders.
 *
 * Three further decisions worth stating rather than leaving to be inferred:
 *
 *   - **No surrogate id.** The primary key is
 *     `(card_id, reset_period, period_started_at)`, which says what the table
 *     means: a card has at most one limit of a given kind per window. A
 *     surrogate key plus a unique constraint would express the same rule less
 *     directly, and the dashboard's limit lookup is a primary-key read either
 *     way.
 *   - **No currency column.** Money in this repo is an integer minor-unit
 *     amount paired with an explicit ISO-4217 code, and the code for a limit is
 *     the owning company's `default_currency_code`, reached through
 *     `cards.company_id`. Repeating it here would let a card's limit be
 *     denominated in a currency its transactions are not.
 *   - **`ON DELETE CASCADE`, unlike every other foreign key in this schema.** A
 *     spend limit is configuration scoped to a card and has no meaning without
 *     it. A transaction is a financial record, so `transactions` uses
 *     `RESTRICT` — the split is deliberate, not an oversight in one of the two.
 */
import { integer, pgEnum, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';

import { cards } from './cards';

/**
 * How often the cap resets. Provider vocabulary: the contract publishes a
 * remaining-spend figure and its limit, and never says the word "reset".
 *
 * As with `card_lifecycle_status`, this enum carries no `unknown` member — see
 * `cards.ts` for why a database enum must not mirror that contract convention.
 * Adding a member here stays a non-breaking change precisely because the
 * contract's own enum has an `unknown` to fold it onto.
 */
export const spendLimitResetPeriod = pgEnum('spend_limit_reset_period', [
  'monthly',
  'quarterly',
  'annual',
]);

export const spendLimits = pgTable('spend_limits', {
  cardId: uuid('card_id')
    .notNull()
    .references(() => cards.id, { onDelete: 'cascade' }),
  // Signed `integer`, so the ceiling is 2 147 483 647 minor units — 21 474 836.47
  // in a two-decimal currency. A product that outgrows it widens the column to
  // `bigint`, which is a migration the provider owns and a change no consumer
  // can see: the contract states its own integer type independently.
  capMinorUnits: integer('cap_minor_units').notNull(),
  resetPeriod: spendLimitResetPeriod('reset_period').notNull(),
  // The instant the current window opened, not a calendar date: it is compared
  // against `transactions.booked_at` to decide which transactions count
  // towards the cap, and both sides being `timestamptz` keeps that comparison
  // free of a time-zone reading.
  periodStartedAt: timestamp('period_started_at', {
    withTimezone: true,
    mode: 'date',
  }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.cardId, table.resetPeriod, table.periodStartedAt] }),
]);

/** A spend-limit row as it comes back from a query. */
export type SpendLimit = typeof spendLimits.$inferSelect;

/**
 * A spend-limit row as it goes in. Nothing is optional: the table has no
 * generated column, so every part of the composite key must be supplied.
 */
export type NewSpendLimit = typeof spendLimits.$inferInsert;

/** The reset periods the provider knows about — not the contract's, and without `unknown`. */
export type SpendLimitResetPeriod = SpendLimit['resetPeriod'];
