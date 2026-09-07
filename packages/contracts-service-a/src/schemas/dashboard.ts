/**
 * The whole mobile view in one payload: the selected company, its card, the
 * remaining-spend meter, the three latest transactions and the count behind
 * `54 more items in transaction view`.
 *
 * ## Why this is one aggregated response and not five resources
 *
 * The screen is one view, opened once, on a phone. Served as five REST
 * resources it costs five round trips on a cellular link, renders in five
 * stages, and shifts layout as each arrives. Aggregating them is not a
 * shortcut around REST — it is the payload the consumer actually needs, and the
 * spec's whole premise is that the consumer is the one who gets to say so.
 *
 * Two of the fields settle the argument on their own, because no amount of
 * client-side composition produces them:
 *
 * - **`spend.remaining` is not stored anywhere.** It is the cap minus the
 *   settled transactions inside the current window, and `spend_limits` in
 *   `@marcos-corp/db` deliberately has no `remaining` column — a stored copy is
 *   a second source of truth that drifts the moment a transaction settles. A
 *   consumer could only compute it by fetching every transaction in the window
 *   and reimplementing the settlement and window filters, which is the
 *   provider's rule to own.
 * - **`furtherTransactionCount` is a count of rows the consumer never sees.**
 *   The screen renders it verbatim.
 *
 * Both are the strongest argument in this repository for spec §2.1: a schema
 * derived from the tables could not state either field, because neither is a
 * column.
 *
 * ## What this response deliberately does not carry
 *
 * The `Invoice due >` banner at the top of the screen is missing on purpose.
 * Invoices belong to `service-b`, and having `service-a` fan out to fetch them
 * would put one team's contract behind another team's availability and make
 * every `service-b` outage a `service-a` outage. The consumer makes a second
 * call for the banner; the ownership graph in spec §1 is the reason it is worth
 * the round trip.
 *
 * There is no `total` transaction count either. `furtherTransactionCount` is
 * what the screen renders, and publishing both would be two derived figures a
 * consumer could find in disagreement. The total is available where it is
 * actually useful — on the paginated transaction list, in `PageInfo.total`.
 */
import type { Static } from '@sinclair/typebox';

import { Type } from '@sinclair/typebox';

import { Card } from './card';
import { CompanySummary } from './company';
import { MonetaryAmount, responseObject } from './shared';
import { Transaction } from './transaction';

/** Counts start at zero: a company with three transactions and no more. */
const NON_NEGATIVE_MINIMUM = 0;

/**
 * How many transactions the dashboard lists. Three, because that is what the
 * screen draws — and the ceiling is published so a consumer can size its layout
 * from the document rather than from a response it happened to receive.
 */
export const DASHBOARD_TRANSACTION_COUNT = 3;

/**
 * The "Remaining spend" card: `5 400/10 000 kr`, with the two figures separate.
 *
 * Never a preformatted string and never a percentage. `5 400/10 000 kr` is the
 * consumer's rendering of two amounts, and publishing it as text would move the
 * provider's locale into every client and make the numbers unusable for
 * anything but display — the same mistake `MonetaryAmount` exists to prevent.
 * A percentage would throw away the figures the screen actually prints.
 *
 * `remaining` is signed, because `MonetaryAmount.minorUnits` is: a card whose
 * settled spend has overrun its cap reports a negative remaining figure rather
 * than a clamped zero that hides the overrun.
 *
 * Both amounts carry their own ISO-4217 code, and both are always the owning
 * company's currency — an invariant the provider holds rather than one the
 * shape enforces. Encoding it structurally would mean a bespoke money object
 * with one currency and two integers, and a second money shape in a contract
 * whose whole money convention is one component is a worse trade than a stated
 * invariant. A consumer renders the symbol once, from either.
 *
 * No `$id`. It appears inside exactly one shape, and the convention this
 * package follows hoists what more than one operation names — a component here
 * would put the meter's two figures one indirection away from the field that
 * carries them, for no reuse.
 */
export const SpendSummary = responseObject({
  remaining: MonetaryAmount,
  limit: MonetaryAmount,
}, {
  description:
    'What is left to spend in the current period, and the limit it is measured '
    + 'against.',
});
export type SpendSummary = Static<typeof SpendSummary>;

/**
 * The dashboard payload.
 *
 * Carries an `$id` even though one operation returns it. The convention in this
 * package hoists a shape more than one operation names, and inlines the rest;
 * an operation's own response is the third case, and it is worth naming because
 * that name is what a consumer's generated client binds to and what the diff
 * gate reports a change against. `SpendSummary` above is the counterexample —
 * nested, named by nothing else, and left inline.
 *
 * Every shape it shares with another operation reaches the emitted document as
 * a `$ref` — `CompanySummary`, `Card`, and `Transaction` inside the array. That
 * is what makes the diff gate's report readable: a field added to `Card` shows
 * up once, against `Card`, rather than once per operation that embeds it.
 */
export const Dashboard = responseObject({
  company: CompanySummary,
  card: Card,
  spend: SpendSummary,
  latestTransactions: Type.Array(Transaction, {
    description: 'The newest transactions, newest first.',
    // No `minItems`: a company whose card has never been used has none, and a
    // schema that forbade the empty list would make the first day of a new
    // account an error. `maxItems` states what the provider will send, so a
    // consumer sizes its layout from the document.
    maxItems: DASHBOARD_TRANSACTION_COUNT,
  }),
  furtherTransactionCount: Type.Integer({
    description:
      'Transactions beyond the ones listed here, for the `N more items` link.',
    minimum: NON_NEGATIVE_MINIMUM,
    examples: [54],
  }),
}, {
  $id: 'Dashboard',
  description: 'Everything the mobile view renders, in one response.',
});
export type Dashboard = Static<typeof Dashboard>;
