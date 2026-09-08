/**
 * The invoice behind the `Invoice due >` banner at the top of the mobile view,
 * as `service-b` publishes it.
 *
 * `service-a` deliberately leaves this out of its dashboard: invoices belong to
 * another team, and having one provider fan out to another would make every
 * `service-b` outage a `service-a` outage. The consumer makes a second call for
 * the banner, and this is the shape it gets back.
 *
 * ## The payment state enum is the reason this file matters
 *
 * `invoices.payment_state` in `@marcos-corp/db` has four members — `draft`,
 * `issued`, `paid`, `written_off` — and no `unknown`. This enum has three
 * members and an `unknown`, and every difference is load-bearing:
 *
 * - **It carries `unknown`, which the database enum must not** (spec §2.5).
 *   That member is what makes adding a provider-side state a non-breaking
 *   change: a consumer pinned to a version predating it folds the value onto
 *   `unknown` and keeps rendering the banner, instead of throwing on a payload
 *   it validated a moment ago. The mapper in `services/service-b` is where the
 *   fold happens; the member is what gives it somewhere to fold onto. A
 *   database enum has no such reader — every value in it was written by code
 *   that knew the enum — which is why adding one there is the safe half of the
 *   same change.
 * - **It is spelled differently, and coarser.** `issued` is the provider's
 *   word for "we have sent it"; a consumer's question is whether the company
 *   still owes the money, so it is published as `awaiting_payment`.
 *   `written_off` is the provider's accounting outcome, published as
 *   `cancelled` because what a consumer needs to know is that nothing is owed
 *   and the banner should not ask for payment.
 * - **`draft` has no contract member at all.** An invoice the company has not
 *   been sent does not exist as far as a consumer is concerned, and giving it a
 *   published name would oblige this provider to keep emitting one. It is the
 *   worked example of a database value the contract simply does not have.
 *
 * ## Why the enum is not a single member plus `unknown`
 *
 * Today's one operation returns the invoice a company still owes, so in
 * practice the field is always `awaiting_payment` — which reads like an
 * argument for publishing only that. It is not, and the seed in `packages/db`
 * is the reason: it plants a second, already-`paid` invoice due *earlier* than
 * the issued one, precisely so a lookup that forgets `payment_state = 'issued'`
 * returns the wrong row rather than being accidentally right.
 *
 * With this enum, a consumer handed that row renders a settled invoice as
 * settled and the bug is visible on the screen. With a one-member enum it would
 * have no way to say anything but "you owe this", and the provider's mistake
 * would be indistinguishable from correct behaviour. `paymentState` is a fact
 * about the invoice, not about the operation that fetched it.
 *
 * Built with `Type.Unsafe` rather than `Type.Union([Type.Literal(...)])`. The
 * idiomatic TypeBox spelling emits `anyOf` of `const`s, which is an enum a
 * human reads as an enum and which house rule 3 — whose `given` selects nodes
 * carrying `enum` — never sees. Spec §2.5's unknown-member requirement would go
 * unenforced on the one schema in this contract most likely to grow a value.
 *
 * ## What this schema deliberately does not carry
 *
 * - **No `companyId`.** The invoice is reached through a company the caller
 *   already named in the path, so repeating it would publish a second source of
 *   the same truth and oblige the provider to keep the two consistent.
 * - **No `overdue` flag, and no "days remaining".** Whether an invoice is late
 *   is `dueOn` compared against today, which the consumer already knows and can
 *   compute in its own timezone. A provider-computed flag would be a figure
 *   that goes stale at midnight with nothing to recompute it — the same
 *   argument `packages/db` makes for the table having no such column, and the
 *   same one `service-a`'s dashboard makes for publishing two spend figures
 *   rather than a percentage.
 * - **No line items, no PDF link, no recipient.** The banner renders an amount
 *   and a date. Removing a required response property later is breaking and
 *   forces spec §6.2's major version; adding one is the additive change spec
 *   §6.1 lets a consumer author and ship the same day. The cheap direction is
 *   the one to leave room in.
 */
import type { Static } from '@sinclair/typebox';

import { Type } from '@sinclair/typebox';

import { CalendarDate, MonetaryAmount, responseObject } from './shared';

/**
 * Defensive upper bound on an identifier arriving in a request. See
 * `COMPANY_ID_MAX_LENGTH` in `./shared` for why the two are stated separately
 * rather than shared.
 */
const INVOICE_ID_MAX_LENGTH = 64;

/**
 * An invoice identifier.
 *
 * Opaque and without `format: 'uuid'`, for the reason `CompanyId` gives: the
 * key scheme behind it is the provider's to change. No `$id`, for the reason
 * every scalar in this package lacks one.
 *
 * The example is the identifier `packages/db`'s seed inserts for the due
 * invoice, so the Prism mock and a running `service-b` answer with the same
 * value.
 */
export const InvoiceId = Type.String({
  description: 'Opaque invoice identifier. Echo it back; never parse it.',
  minLength: 1,
  maxLength: INVOICE_ID_MAX_LENGTH,
  examples: ['33333333-3333-4333-8333-333333333333'],
});
export type InvoiceId = Static<typeof InvoiceId>;

/**
 * Where an invoice has reached, from the paying company's side.
 *
 * Ordered as an invoice travels: still owed, settled, then written off — and
 * then the member that is not a state at all.
 *
 * A consumer's `switch` over these must be exhaustive, `unknown` included. That
 * is the half of spec §2.5 a schema cannot enforce on its own, so `apps/web-b`
 * carries a test asserting a consumer folds an unrecognised value onto
 * `unknown` and keeps going.
 */
export const INVOICE_PAYMENT_STATES = [
  // Sent to the company and not yet settled — the state the banner exists for.
  // The provider distinguishes an invoice it is still drafting from one it has
  // sent; a consumer only ever sees the second.
  'awaiting_payment',
  // Settled in full. Nothing is owed; the banner is not a call to action.
  'paid',
  // The provider has given up on collecting it. Nothing is owed here either,
  // and the distinction from `paid` is one a company reading its own invoices
  // is entitled to.
  'cancelled',
  // Not in this list. Emitted by a provider reporting a state added after the
  // consumer's pinned version, and folded onto by a consumer receiving one.
  'unknown',
] as const;

/** The union a consumer's `switch` is exhaustive against. */
export type InvoicePaymentState = (typeof INVOICE_PAYMENT_STATES)[number];

/**
 * `paymentState` as a schema. See the header for why this is `Type.Unsafe` and
 * not the idiomatic union of literals.
 */
export const InvoicePaymentState = Type.Unsafe<InvoicePaymentState>({
  type: 'string',
  enum: [...INVOICE_PAYMENT_STATES],
  description: 'Invoice payment state. Unrecognised values are `unknown`.',
});

/**
 * An invoice, as the banner renders it.
 *
 * Carries an `$id` because it is the shape this contract's one operation
 * returns — the name a consumer's generated client binds to and the one the
 * diff gate reports a change against. It is hoisted into `components.schemas`
 * rather than inlined for that reason, not because it is reused.
 *
 * `total` references the shared `MonetaryAmount` rather than spreading it: a
 * spread would produce a second schema carrying the same `$id` with different
 * content, which gate 1 refuses outright. What the field means is stated here,
 * in the shape that owns it.
 */
export const Invoice = responseObject({
  id: InvoiceId,
  // Reuses the shared calendar date and restates only what the field means.
  // The spread keeps TypeBox's `Kind` symbol, so this is still the same schema
  // — asserted in `invoice.test.ts`, where the inherited `format` is what says
  // the spread happened rather than a hand-written copy.
  dueOn: {
    ...CalendarDate,
    description: 'The day the invoice falls due, in the company\'s jurisdiction.',
  },
  total: MonetaryAmount,
  paymentState: InvoicePaymentState,
}, {
  $id: 'Invoice',
  description: 'An invoice as the mobile view\'s `Invoice due` banner renders it.',
});
export type Invoice = Static<typeof Invoice>;
