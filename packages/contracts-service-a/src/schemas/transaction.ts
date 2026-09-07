/**
 * A row under "Latest transactions" on the mobile view: the merchant on the
 * left, the amount on the right, and the two enums a consumer branches on.
 *
 * ## Two enums, two different kinds of divergence from the database
 *
 * `transactions` in `@marcos-corp/db` has a `settlement_state` enum and a raw
 * `merchant_category_code` column, and neither reaches a consumer unchanged.
 * They diverge for different reasons, which is why both are here:
 *
 * - **`settlementState` is a rename plus a fold.** The database's vocabulary is
 *   the clearing cycle's — `authorised`, `settled`, `reversed`, `disputed` —
 *   and the first two are the issuer's and the acquirer's words rather than the
 *   cardholder's. This enum publishes three states plus `unknown`, defined by
 *   what a consumer can act on: whether the amount is final, and whether it
 *   counts against the limit the meter renders. `disputed` folds onto
 *   `pending` under that definition, because a contested charge is precisely
 *   one whose outcome is not yet fixed. See the member comments.
 * - **`merchantCategory` is a coarsening of an open set.** The column holds an
 *   ISO-18245 MCC, a four-digit code the card networks extend without asking
 *   anyone. The provider cannot enumerate them and must not publish them: a
 *   consumer that switched on `5814` would be switching on a standard neither
 *   party controls. So the contract publishes a handful of categories a
 *   business cardholder recognises, and the mapper folds the code onto one.
 *
 * The second is the concrete reason spec §2.5 requires an explicit `unknown`
 * member on every enum. A new MCC arriving in the acquirer feed is not a
 * contract change and cannot be allowed to become one — the mapper folds it
 * onto `unknown` and a consumer pinned to last month's version keeps rendering.
 *
 * Both are built with `Type.Unsafe` rather than `Type.Union([Type.Literal()])`.
 * The idiomatic TypeBox spelling emits an `anyOf` of `const`s, which reads as
 * an enum to a human and which house rule 3 — whose `given` selects nodes
 * carrying `enum` — never sees. Spec §2.5 would go unenforced on exactly the
 * two schemas in this contract most likely to grow a member.
 *
 * ## What the row publishes, and what it leaves out
 *
 * `merchantName` and `amount` are the "Transaction data" and "Data points" the
 * screen renders; `bookedAt` is what "latest" is ordered by. There is no
 * `cardId` and no `companyId`: a transaction is reached through a company the
 * caller already selected, so repeating either would publish a second source of
 * the same truth and oblige the provider to keep them consistent.
 *
 * There is no dispute status either, and that is the deliberate consequence of
 * folding `disputed` onto `pending`. The screen has no dispute UI, and a field
 * added when it grows one is the additive change spec §6.1 lets a consumer
 * author and ship the same day. Removing a required response property is the
 * expensive direction (`response-required-property-removed` fails gate 3 and
 * forces the major-version procedure in spec §6.2), so the cheap direction is
 * the one to leave room in.
 */
import type { Static } from '@sinclair/typebox';

import { Type } from '@sinclair/typebox';

import { MonetaryAmount, responseObject, Timestamp } from './shared';

/**
 * Defensive upper bound on an identifier arriving in a request. Stated per
 * identifier rather than shared with `CompanyId` and `CardId` — see
 * `COMPANY_ID_MAX_LENGTH` in `./company` for why one component for "an id" is
 * how loosening one silently loosens the others.
 */
const TRANSACTION_ID_MAX_LENGTH = 128;

/**
 * A transaction identifier, as it appears in a response and in a later request
 * that addresses one row.
 *
 * Opaque, and deliberately without `format: 'uuid'`, for the reason `CompanyId`
 * gives: the key scheme behind it is the provider's to change. No `$id`, for
 * the reason every scalar in this package lacks one.
 *
 * The example is the newest row `packages/db`'s seed inserts, so the Prism mock
 * and a running `service-a` answer with the same value.
 */
export const TransactionId = Type.String({
  description: 'Opaque transaction identifier. Echo it back; never parse it.',
  minLength: 1,
  maxLength: TRANSACTION_ID_MAX_LENGTH,
  examples: ['55555555-5555-4555-8555-000000000001'],
});
export type TransactionId = Static<typeof TransactionId>;

/**
 * How far a transaction has got, as a cardholder experiences it.
 *
 * Ordered as money moves: not final yet, final, taken back — then the member
 * that is not a state at all.
 *
 * A consumer's `switch` over these must be exhaustive, `unknown` included. That
 * is the half of spec §2.5 a schema cannot enforce on its own, so `web-b`
 * carries a test asserting it folds an unrecognised value onto `unknown` and
 * keeps going rather than throwing.
 */
export const TRANSACTION_SETTLEMENT_STATES = [
  // The amount is not fixed yet, so it is not counted against the limit. Two
  // database states fold onto this one: an `authorised` charge the acquirer has
  // not settled, and a `disputed` one whose outcome is open. Both mean the same
  // thing to a consumer — do not treat this figure as final — and separating
  // them would publish the provider's dispute workflow without the screen
  // having anywhere to put it.
  'pending',
  // Settled. The amount is final, and this is the only state counted against
  // the spend limit the dashboard's meter renders. Another module depends on
  // that by name: `services/service-a`'s dashboard mapper subtracts exactly
  // these from the cap.
  'completed',
  // The charge was released and will never be billed. Final, and not counted.
  'reversed',
  // Not in this list. Emitted by a provider reporting a state added after the
  // consumer's pinned version, and folded onto by a consumer receiving one.
  'unknown',
] as const;

/** The union a consumer's `switch` is exhaustive against. */
export type TransactionSettlementState = (typeof TRANSACTION_SETTLEMENT_STATES)[number];

/**
 * `settlementState` as a schema. See the header for why this is `Type.Unsafe`
 * and not the idiomatic union of literals.
 */
export const TransactionSettlementState = Type.Unsafe<TransactionSettlementState>({
  type: 'string',
  enum: [...TRANSACTION_SETTLEMENT_STATES],
  description:
    'How far the transaction has got. Unrecognised values are `unknown`.',
});

/**
 * What kind of merchant the transaction was with.
 *
 * Alphabetical, with `unknown` last. There is no natural order to a set of
 * categories, and alphabetical makes the position a new member is inserted at
 * obvious in a diff — which is the only thing ordering buys here.
 *
 * The set is small on purpose. Every member is a category a business cardholder
 * would recognise on an expense report, and each maps from a range of MCCs
 * rather than from one: `travel` takes hotels, rail and local transit together,
 * because a business expense groups them and a consumer draws one icon for all
 * three. A finer set would be a taxonomy the provider then owes consumers
 * forever, for a screen that renders a merchant name and an amount.
 */
export const MERCHANT_CATEGORIES = [
  // Restaurants, cafes and fast food.
  'dining',
  // Service stations and charging. Its own member rather than part of
  // `travel`: it is the highest-volume category on a business card, and the
  // one a spend report is most often broken out by.
  'fuel',
  // Supermarkets and food shops.
  'groceries',
  // General merchandise, hardware and home supply.
  'retail',
  // Software, hosting and other digital services.
  'software',
  // Telephony, mobile and connectivity.
  'telecom',
  // Hotels, rail, air and local transit.
  'travel',
  // Not in this list, in both directions: an MCC the provider cannot classify,
  // and a category added after the consumer's pinned version. A consumer
  // renders both the same way — as a transaction whose kind it does not know —
  // so distinguishing them here would be a member nobody can act on.
  'unknown',
] as const;

/** The union a consumer's `switch` is exhaustive against. */
export type MerchantCategory = (typeof MERCHANT_CATEGORIES)[number];

/**
 * `merchantCategory` as a schema. `Type.Unsafe` for the same reason as
 * `TransactionSettlementState` — see the header.
 */
export const MerchantCategory = Type.Unsafe<MerchantCategory>({
  type: 'string',
  enum: [...MERCHANT_CATEGORIES],
  description:
    'Coarse merchant category, folded from an ISO-18245 MCC. Unrecognised '
    + 'values are `unknown`.',
});

/**
 * One transaction, as the dashboard lists it and as the paginated transaction
 * view behind `54 more items` returns it.
 *
 * Carries an `$id` because it is reused across those two operations, so an edit
 * to it reads as a single change in the diff gate rather than one per usage,
 * and a consumer binds to one type.
 *
 * `amount` is the shared `MonetaryAmount`: an integer count of the currency's
 * minor unit plus its ISO-4217 code, signed so a refund needs no second field.
 * The table behind it stores those as two flat columns, and assembling the pair
 * is the mapper's job — the divergence spec §2.1 exists to preserve.
 */
export const Transaction = responseObject({
  id: TransactionId,
  // Reuses the shared instant and restates only what the field means. The
  // spread keeps TypeBox's `Kind` symbol, so this is still the same schema, and
  // it keeps `format: 'date-time'` — which a mock generates from and a
  // consumer's codegen reads. A hand-written copy would drift from the shared
  // schema silently, since no gate compares the two.
  bookedAt: {
    ...Timestamp,
    description: 'When the transaction reached the ledger. Orders the list.',
  },
  merchantName: Type.String({
    description: 'Merchant name as the acquirer reported it.',
    minLength: 1,
    examples: ['Scandic Malmo'],
  }),
  merchantCategory: MerchantCategory,
  // A `$ref` to the shared component rather than a spread of it: spreading a
  // schema that carries `$id` would hoist a second component under the same
  // name, and the money convention is the one thing in this contract that must
  // read identically everywhere it appears.
  amount: MonetaryAmount,
  settlementState: TransactionSettlementState,
}, {
  $id: 'Transaction',
  description: 'One transaction, as the dashboard and the list both render it.',
});
export type Transaction = Static<typeof Transaction>;
