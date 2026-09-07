/**
 * The `transactions` table: the three rows under "Latest transactions", the
 * `54 more items in transaction view` behind them, and the settled sum the
 * remaining-spend meter is derived from.
 *
 * Where this table diverges from what `packages/contracts-service-a` will
 * publish, and why each divergence is load-bearing rather than decorative
 * (spec §2.1):
 *
 *   - **Money is two flat columns; the contract publishes one object.** A
 *     transaction amount reaches a consumer as an integer minor-unit value
 *     paired with its ISO-4217 code, and assembling that pair is the mapper's
 *     job. A schema derived from these columns would publish
 *     `amount_minor_units` and `currency_code` side by side and make the
 *     repo-wide money convention a database detail consumers depend on.
 *   - **`merchant_category_code` is a raw ISO-18245 MCC; the contract publishes
 *     a coarse enum.** MCCs are an open set the card networks extend without
 *     asking, so the provider cannot enumerate them and the mapper folds an
 *     unrecognised code onto the contract enum's `unknown` member. That is the
 *     concrete reason spec §2.5 requires an explicit unknown member: a new MCC
 *     arriving in the acquirer feed must not break a consumer pinned to last
 *     month's contract.
 *   - **The settlement states are the provider's vocabulary.** `authorised` is
 *     not `pending`, and a consumer never learns that a disputed transaction is
 *     distinct from a reversed one unless the contract chooses to say so.
 *
 * Two facts a reader has to have before writing a query against this table:
 *
 *   - **`amount_minor_units` is signed.** A refund is negative, so the settled
 *     sum is net spend and `cap - SUM(settled)` is the remaining figure without
 *     a special case.
 *   - **`company_id` is denormalised on purpose**, and the two foreign keys
 *     below do not enforce that it matches the card's company. Enforcing it in
 *     the database needs a composite key against `cards (id, company_id)`;
 *     until then the invariant is the writer's, held by the seed and the
 *     repository layer. Recorded here rather than left for someone to discover
 *     from a mismatched row.
 */
import {
  char,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { cards } from './cards';
import { companies } from './companies';

/** ISO-4217 alphabetic codes are exactly three characters. */
const CURRENCY_CODE_LENGTH = 3;

/** ISO-18245 merchant category codes are exactly four digits. */
const MERCHANT_CATEGORY_CODE_LENGTH = 4;

/**
 * Where a transaction has reached in the clearing cycle, provider-side:
 * authorised by the issuer, settled by the acquirer, reversed when an
 * authorisation is released, disputed when the cardholder charges it back.
 *
 * `settled` is the member the remaining-spend calculation filters on, so it is
 * the one member of this enum that another module depends on by name.
 *
 * No `unknown` member, for the reason spelled out in `cards.ts`: that is a
 * contract convention protecting a consumer reading a value its pinned version
 * predates, and a database enum has no such reader.
 */
export const transactionSettlementState = pgEnum('transaction_settlement_state', [
  'authorised',
  'settled',
  'reversed',
  'disputed',
]);

export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey()
    .defaultRandom(),
  cardId: uuid('card_id')
    .notNull()
    .references(() => cards.id, { onDelete: 'restrict' }),
  // Denormalised: every read on the dashboard path is scoped to a company, and
  // a card cannot change hands. See the header for the invariant this leaves
  // to the writer.
  companyId: uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'restrict' }),
  // When the transaction hit the ledger, which is the ordering the screen
  // shows. Not when the card was swiped: an acquirer can book days later, and
  // conflating the two makes "latest" unstable.
  bookedAt: timestamp('booked_at', { withTimezone: true, mode: 'date' }).notNull(),
  // Signed integer minor units — never a float, never a preformatted string.
  // Same 2 147 483 647 ceiling and the same widening path as
  // `spend_limits.cap_minor_units`.
  amountMinorUnits: integer('amount_minor_units').notNull(),
  currencyCode: char('currency_code', { length: CURRENCY_CODE_LENGTH }).notNull(),
  merchantName: text('merchant_name').notNull(),
  merchantCategoryCode: char('merchant_category_code', {
    length: MERCHANT_CATEGORY_CODE_LENGTH,
  }).notNull(),
  settlementState: transactionSettlementState('settlement_state').notNull(),
}, (table) => [
  // Covers both reads the mobile view drives: the three latest transactions for
  // a company, and the paginated transaction view behind `54 more items`.
  //
  // Ascending on purpose, even though both reads sort newest first. Drizzle's
  // index builder renders `.desc()` as `DESC NULLS LAST`, which is the opposite
  // of Postgres's default for a descending sort, and the planner matches a
  // pathkey literally — so an index declared that way is unusable by a plain
  // `ORDER BY booked_at DESC` even though the column is NOT NULL. An ascending
  // index has no such qualifier and is read backwards for the same query.
  index('transactions_company_id_booked_at_idx').on(table.companyId, table.bookedAt),
]);

/** A transaction row as it comes back from a query. */
export type Transaction = typeof transactions.$inferSelect;

/** A transaction row as it goes in. `id` is optional: the database generates it. */
export type NewTransaction = typeof transactions.$inferInsert;

/** The database's own settlement states — not the contract's, and without `unknown`. */
export type TransactionSettlementState = Transaction['settlementState'];
