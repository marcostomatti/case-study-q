/**
 * A Drizzle `transactions` row, translated into the `Transaction` the contract
 * publishes.
 *
 * The card mapper beside this one exists because a column is named
 * differently. This one exists because three separate kinds of divergence meet
 * in a single row, and only the first of them is a rename:
 *
 * - **A rename plus a fold.** `settlement_state` is the clearing cycle's
 *   vocabulary — `authorised`, `settled`, `reversed`, `disputed` — and the
 *   contract publishes what a cardholder can act on. `disputed` folds onto
 *   `pending` because a contested charge is precisely one whose outcome is not
 *   fixed, and publishing the difference would put the provider's dispute
 *   workflow in a contract the screen has nowhere to render it from.
 * - **A structural difference.** The table stores `amount_minor_units` and
 *   `currency_code` as two flat columns; the contract publishes one
 *   `MonetaryAmount`. Assembling that pair is this file's job. A derived schema
 *   would publish the two columns side by side and make the repo-wide money
 *   convention a database detail every consumer copies.
 * - **A coarsening of an open set.** `merchant_category_code` holds a raw
 *   ISO-18245 MCC, a four-digit code the card networks extend without asking
 *   anyone. The provider cannot enumerate them and must not publish them: a
 *   consumer switching on `5814` would be switching on a standard neither
 *   party controls. The contract publishes seven categories a business
 *   cardholder recognises, and this file folds a code onto one.
 *
 * That third one is the concrete reason spec section 2.5 requires an explicit
 * `unknown` member on every enum. A new MCC arriving in the acquirer feed is
 * not a contract change and must not be allowed to become one: it folds onto
 * `unknown` and a consumer pinned to last month's version keeps rendering.
 * `unknown` is load-bearing here in a way it is not for the settlement state,
 * where the provider does own the vocabulary.
 *
 * ## The two lookups are shaped differently, on purpose
 *
 * `SETTLEMENT_STATE_BY_DATABASE_STATE` is a **total record** over the database
 * enum, so a member added to `transaction_settlement_state` without a decision
 * taken here fails `bun run check-types`. That is possible because the
 * provider owns that enum and its members are countable.
 *
 * `MERCHANT_CATEGORY_RANGES` cannot be total and does not pretend to be: the
 * MCC space is an external standard with four thousand codes in it, most of
 * which no business card ever sees. It is an ordered, non-overlapping range
 * table covering the codes this provider actually acquires, and everything
 * outside it is `unknown` by design rather than by omission. The colocated
 * suite asserts the ordering and the non-overlap, because a table that quietly
 * overlaps itself answers correctly for whichever entry happens to come first.
 *
 * Both fold functions take a `string` rather than the database's union type,
 * for the reason the card mapper's does: a service deployed against a schema
 * that has moved on receives a value its row type says is impossible, and
 * answering it is the entire point of the `unknown` member.
 */
import type {
  MerchantCategory,
  Transaction as ContractTransaction,
  TransactionSettlementState,
} from '@marcos-corp/contracts-service-a';
import type {
  Transaction as TransactionRow,
  TransactionSettlementState as DatabaseSettlementState,
} from '@marcos-corp/db';

/**
 * What an unrecognised database value becomes (spec section 2.5), for each of
 * the two enums this row carries.
 *
 * Two constants rather than one shared `'unknown'`, because they are members
 * of two different published enums that happen to spell their escape hatch the
 * same way. Sharing one would make dropping either member look like a rename.
 */
const UNKNOWN_SETTLEMENT_STATE: TransactionSettlementState = 'unknown';
const UNKNOWN_MERCHANT_CATEGORY: MerchantCategory = 'unknown';

/** ISO-18245 merchant category codes are exactly four digits. Nothing else is one. */
const MERCHANT_CATEGORY_CODE = /^[0-9]{4}$/;

/** Base 10, stated rather than left to `parseInt`'s inference. */
const DECIMAL_RADIX = 10;

/**
 * The contract state each database settlement state folds onto.
 *
 * Total over `DatabaseSettlementState` — see the module header for why this
 * one can be and the category table cannot.
 */
const SETTLEMENT_STATE_BY_DATABASE_STATE:
Readonly<Record<DatabaseSettlementState, TransactionSettlementState>> = {
  // Authorised by the issuer, not yet settled by the acquirer: the amount can
  // still change, so it is not counted against the limit the meter renders.
  authorised: 'pending',
  // The only state the dashboard mapper subtracts from the spend cap.
  settled: 'completed',
  // Released and never billed. Final, and not counted.
  reversed: 'reversed',
  // Charged back and open. Folds onto `pending` under the contract's own
  // definition of that member — an amount whose outcome is not fixed.
  disputed: 'pending',
};

/**
 * The same table as a `Map`, which is what makes the fold cast-free. See the
 * card mapper's equivalent for the argument.
 */
const SETTLEMENT_STATE_LOOKUP = new Map<string, TransactionSettlementState>(
  Object.entries(SETTLEMENT_STATE_BY_DATABASE_STATE),
);

/**
 * One inclusive run of merchant category codes, and what it publishes as.
 *
 * `Exclude<MerchantCategory, 'unknown'>` is deliberate: a range may never
 * declare `unknown`. That member means "no range claimed this code", and a
 * table entry producing it would make an unclassifiable MCC indistinguishable
 * from one somebody classified as unclassifiable.
 */
export interface MerchantCategoryRange {
  /** First code in the run, inclusive. */
  readonly from: number;
  /** Last code in the run, inclusive. */
  readonly to: number;
  readonly category: Exclude<MerchantCategory, 'unknown'>;
}

/**
 * The MCC runs this provider classifies, ascending and non-overlapping.
 *
 * Ascending and non-overlapping rather than ordered by specificity, so no
 * entry's meaning depends on where it sits in the list — the ranges that would
 * otherwise nest are split instead (`5734`, computer software stores, is cut
 * out of the electronics run around it). The colocated suite asserts both
 * properties, because an accidental overlap answers correctly for whichever
 * entry is reached first and reads as a working table.
 *
 * Coarse on purpose. Every category is one a business cardholder would
 * recognise on an expense report, and a finer set is a taxonomy the provider
 * then owes consumers forever — for a screen that renders a merchant name and
 * an amount.
 *
 * Exported so the colocated suite can assert the ordering and non-overlap
 * invariants directly. A table that quietly overlaps itself still answers, and
 * a behavioural test cannot tell the difference.
 */
export const MERCHANT_CATEGORY_RANGES: readonly MerchantCategoryRange[] = [
  // Local and suburban transit, passenger railways, taxis, bus lines.
  { from: 4111, to: 4131, category: 'travel' },
  // Cruise lines.
  { from: 4411, to: 4411, category: 'travel' },
  // Airlines and air carriers.
  { from: 4511, to: 4511, category: 'travel' },
  // Travel agencies and tour operators.
  { from: 4722, to: 4723, category: 'travel' },
  // Telecommunication equipment and services, including mobile.
  { from: 4812, to: 4816, category: 'telecom' },
  // Cable, satellite and other pay television.
  { from: 4899, to: 4899, category: 'telecom' },
  // Home supply warehouses, lumber, nurseries.
  { from: 5200, to: 5261, category: 'retail' },
  // Wholesale clubs, discount stores, variety stores.
  { from: 5300, to: 5399, category: 'retail' },
  // Supermarkets, bakeries, dairies and other food shops.
  { from: 5411, to: 5499, category: 'groceries' },
  // Service stations and automated fuel dispensers.
  { from: 5541, to: 5542, category: 'fuel' },
  // Electric vehicle charging. Its own entry rather than part of the run
  // above, because ISO-18245 did not put it there.
  { from: 5552, to: 5552, category: 'fuel' },
  // Clothing and accessories.
  { from: 5651, to: 5699, category: 'retail' },
  // Furniture, household appliances, consumer electronics.
  { from: 5712, to: 5733, category: 'retail' },
  // Computer software stores. Cut out of the electronics run around it so the
  // table stays non-overlapping — see the header.
  { from: 5734, to: 5734, category: 'software' },
  // Record and music shops.
  { from: 5735, to: 5735, category: 'retail' },
  // Restaurants, bars, fast food.
  { from: 5812, to: 5814, category: 'dining' },
  // Digital goods: books, films, music, games, applications.
  { from: 5815, to: 5818, category: 'software' },
  // Miscellaneous and specialty retail.
  { from: 5900, to: 5999, category: 'retail' },
  // Hotels, motels and other lodging.
  { from: 7011, to: 7011, category: 'travel' },
  // Computer programming, data processing and information services.
  { from: 7370, to: 7379, category: 'software' },
];

/**
 * Folds a database settlement state onto the contract's.
 *
 * See the module header for why the parameter is a `string`.
 */
export function toContractSettlementState(
  settlementState: string,
): TransactionSettlementState {
  return SETTLEMENT_STATE_LOOKUP.get(settlementState) ?? UNKNOWN_SETTLEMENT_STATE;
}

/**
 * Folds a raw ISO-18245 merchant category code onto the contract's coarse
 * category.
 *
 * A code no range claims is `unknown`, and so is anything that is not four
 * digits: the column is `char(4)` and a value that is not one has already
 * escaped the schema, so guessing at it would publish a category nobody can
 * account for. Both are the same answer to a consumer — a transaction whose
 * kind the provider does not know.
 */
export function toContractMerchantCategory(merchantCategoryCode: string): MerchantCategory {
  if (!MERCHANT_CATEGORY_CODE.test(merchantCategoryCode)) {
    return UNKNOWN_MERCHANT_CATEGORY;
  }

  const code = Number.parseInt(merchantCategoryCode, DECIMAL_RADIX);
  const range = MERCHANT_CATEGORY_RANGES.find(
    (candidate) => code >= candidate.from && code <= candidate.to,
  );

  return range?.category ?? UNKNOWN_MERCHANT_CATEGORY;
}

/**
 * A `transactions` row as the contract publishes it.
 *
 * `amount` is assembled from the two columns rather than passed through, and
 * `minorUnits` keeps its sign: a refund is negative, which is what lets the
 * dashboard mapper compute `cap - SUM(settled)` with no special case.
 *
 * The row carries `cardId` and `companyId` and neither is published. A
 * transaction is reached through a company the caller already selected, so
 * repeating either would publish a second source of the same truth and oblige
 * the provider to keep the two consistent forever.
 */
export function toContractTransaction(row: TransactionRow): ContractTransaction {
  return {
    id: row.id,
    bookedAt: row.bookedAt.toISOString(),
    merchantName: row.merchantName,
    merchantCategory: toContractMerchantCategory(row.merchantCategoryCode),
    amount: {
      minorUnits: row.amountMinorUnits,
      currency: row.currencyCode,
    },
    settlementState: toContractSettlementState(row.settlementState),
  };
}
