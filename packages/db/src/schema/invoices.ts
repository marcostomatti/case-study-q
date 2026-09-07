/**
 * The `invoices` table: the `Invoice due` banner at the top of the mobile view,
 * and the row `service-b` serves through its own contract.
 *
 * It lives here rather than in a second database because ownership in this PoC
 * is by team, not by schema — `packages/db` is owned by both service teams
 * (`.github/CODEOWNERS`) and is a dependency of neither contract package. The
 * governance boundary that matters is spec §2.1's: `contracts-service-b`
 * hand-authors the invoice schema and `service-b` maps this row onto it.
 *
 * Where this table diverges from what `packages/contracts-service-b` will
 * publish, and why each divergence is load-bearing:
 *
 *   - **`due_on` is a calendar date, and it is the one column in this schema
 *     that does not reach TypeScript as a `Date`.** An invoice falls due on a
 *     day in the company's jurisdiction, not at an instant, so the column is
 *     `date` and its `mode` is pinned to `'string'`. A JavaScript `Date` for a
 *     calendar date carries a time-of-day nobody chose and renders as the
 *     previous day for any reader east or west of whoever wrote it. That mode
 *     is invisible to `getSQLType()` — all three drizzle modes render `date` —
 *     so `invoices.test-d.ts` is the only thing that can pin it.
 *   - **There is no `overdue` state, and there must not be one.** Whether an
 *     invoice is *due* is `due_on` compared against today; a stored flag is a
 *     second source of truth that goes stale at midnight with nothing to
 *     recompute it. Same argument as `spend_limits` having no `remaining`
 *     column, and the same consequence: the banner the screen renders cannot be
 *     derived from any single column here, which is why the contract is
 *     hand-authored and a mapper assembles the payload.
 *   - **Money is two flat columns; the contract publishes one object.** As in
 *     `transactions` — `total_minor_units` paired with `currency_code` becomes
 *     a single money value in the payload, and the pairing is the mapper's job.
 *   - **The payment states are the provider's vocabulary.** A consumer never
 *     learns that a `draft` invoice exists, and never sees `written_off`.
 *
 * One decision that reads as an inconsistency until it is stated: this table
 * stores a `currency_code` and `spend_limits` deliberately does not. An invoice
 * is a financial record denominated at the moment it is issued, so a company
 * that later changes its `default_currency_code` must not re-denominate an
 * invoice already sent. A spend limit is configuration and has no such history,
 * so it takes the company's current code through `cards.company_id`.
 */
import { char, date, index, integer, pgEnum, pgTable, uuid } from 'drizzle-orm/pg-core';

import { companies } from './companies';

/** ISO-4217 alphabetic codes are exactly three characters. */
const CURRENCY_CODE_LENGTH = 3;

/**
 * Where an invoice has reached, provider-side. Ordered as the invoice travels:
 * drafted internally, issued to the company, paid in full, or written off when
 * it will not be.
 *
 * `issued` is the member the due-invoice lookup filters on, so it is the one
 * member of this enum another module depends on by name.
 *
 * Deliberately no `overdue` — see the header: that is a comparison against
 * today, not a state anything writes. And deliberately no `unknown`, for the
 * reason spelled out in `cards.ts`: that is a contract convention protecting a
 * consumer reading a value its pinned version predates, and a database enum has
 * no such reader. Adding a member here stays a non-breaking change precisely
 * because the contract's own enum has an `unknown` to fold it onto.
 */
export const invoicePaymentState = pgEnum('invoice_payment_state', [
  'draft',
  'issued',
  'paid',
  'written_off',
]);

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey()
    .defaultRandom(),
  companyId: uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'restrict' }),
  // A calendar date, mode pinned rather than left to drizzle's default so the
  // `string` on the other side is a decision this module made. See the header.
  dueOn: date('due_on', { mode: 'string' }).notNull(),
  // Signed integer minor units — never a float, never a preformatted string.
  // Signed because a credit note is a negative invoice. Same 2 147 483 647
  // ceiling and the same widening path as `spend_limits.cap_minor_units`.
  totalMinorUnits: integer('total_minor_units').notNull(),
  currencyCode: char('currency_code', { length: CURRENCY_CODE_LENGTH }).notNull(),
  paymentState: invoicePaymentState('payment_state').notNull(),
}, (table) => [
  // Covers the only read the banner drives: the earliest unpaid invoice for a
  // company, `WHERE company_id = $1 AND payment_state = 'issued'
  // ORDER BY due_on LIMIT 1`.
  //
  // Ascending, as everywhere else in this schema — and here ascending is also
  // the direction the query wants, so the planner reads the index forwards. See
  // `transactions.ts` for why a `.desc()` index would be unusable even when the
  // read sorts the other way.
  index('invoices_company_id_due_on_idx').on(table.companyId, table.dueOn),
]);

/** An invoice row as it comes back from a query. */
export type Invoice = typeof invoices.$inferSelect;

/** An invoice row as it goes in. `id` is optional: the database generates it. */
export type NewInvoice = typeof invoices.$inferInsert;

/** The database's own payment states — not the contract's, and without `unknown`. */
export type InvoicePaymentState = Invoice['paymentState'];
