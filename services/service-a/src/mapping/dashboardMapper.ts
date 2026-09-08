/**
 * The whole mobile view assembled out of four independently-fetched Drizzle
 * rows: the company, its card, the card's spend limit and its transactions.
 *
 * The two mappers beside this one translate a row. This one produces two
 * fields that are not in any row at all, and that is the point:
 *
 * - **`spend.remaining` is computed, not read.** `spend_limits` stores the cap
 *   and deliberately has no `remaining` column — a stored copy is a second
 *   source of truth that drifts the moment a transaction settles. The figure
 *   is `cap - SUM(settled transactions booked inside the current window)`, and
 *   this module is the only place that rule lives.
 * - **`furtherTransactionCount` is a count of rows the consumer never sees.**
 *   The screen renders it verbatim as `54 more items in transaction view`.
 *
 * A schema derived from the tables could state neither field, which makes this
 * file the strongest single argument in the repository for spec section 2.1.
 * Everything else the mapping layer does is a rename or a fold; this is a
 * payload the database cannot describe.
 *
 * ## What counts against the cap, and why both filters live here
 *
 * Two conditions, each of which a plausible implementation drops:
 *
 * - **Settlement.** Only `settled` rows are subtracted. An authorised amount
 *   can still change before it clears, a reversed one was never billed, and a
 *   disputed one is contested — none of them is money the cardholder has
 *   spent. This keys on the *database* state rather than on the contract's
 *   folded one on purpose: the clearing cycle is the provider's vocabulary and
 *   the rule is about it, so a later decision to publish `disputed` as
 *   something else must not silently move the meter.
 * - **The window.** Only rows booked at or after `spend_limits.
 *   period_started_at` count, because the cap is per window. The boundary is
 *   inclusive: a transaction booked as the window opened belongs to it.
 *
 * Both are applied here rather than left to the caller's query, so the figure
 * does not depend on how the repository scoped its read. A caller may hand
 * over the whole collection or just the current window and get the same
 * answer, and `packages/db`'s seed is arranged so that dropping either filter
 * produces a *different* number — `447700` without the settlement filter,
 * `300000` without the window filter — rather than one that happens to agree.
 *
 * Amounts keep their sign, so a refund reduces the spend with no special case.
 * Taking the magnitude instead is the third plausible wrong answer the seed
 * separates, at `510000`.
 *
 * Every amount is denominated in the owning company's currency. That is an
 * invariant `packages/db` records at `spend_limits` — the limit has no
 * currency column precisely so a card's cap cannot be denominated in a
 * currency its transactions are not — rather than one this sum re-checks per
 * row: a row that broke it would be a provider-side data fault, and there is
 * nothing the contract could say about it that a consumer could act on.
 *
 * ## Where `toCompanySummary` lives
 *
 * Here, because the dashboard is the first payload to need it and a company
 * fold is two fields. `listCompanies` needs the same fold, and should import
 * this one rather than grow a second spelling of which two of the table's five
 * columns are published — the same argument the module header of
 * `cardMapper.ts` makes about its own fold table.
 */
import type { CardMappingOptions } from './cardMapper';
import type {
  CompanySummary,
  Dashboard,
  MonetaryAmount,
  Transaction as ContractTransaction,
} from '@marcos-corp/contracts-service-a';
import type {
  Card as CardRow,
  Company as CompanyRow,
  SpendLimit as SpendLimitRow,
  Transaction as TransactionRow,
  TransactionSettlementState as DatabaseSettlementState,
} from '@marcos-corp/db';

import { DASHBOARD_TRANSACTION_COUNT } from '@marcos-corp/contracts-service-a';

import { toContractCard } from './cardMapper';
import { toContractTransaction } from './transactionMapper';

/**
 * The one clearing state that is money already spent.
 *
 * Typed as the database's union rather than written as a bare string, so a
 * member renamed in `transaction_settlement_state` fails `bun run check-types`
 * here instead of silently emptying the sum and reporting the full cap as
 * still available.
 */
const COUNTED_SETTLEMENT_STATE: DatabaseSettlementState = 'settled';

/** A card with no settled spend in the window has spent nothing. */
const NO_SPEND_MINOR_UNITS = 0;

/** What a company with nothing behind the listed transactions reports. */
const NO_FURTHER_TRANSACTIONS = 0;

/** The four rows a dashboard is assembled from, plus the figure behind the count. */
export interface DashboardSources {
  readonly company: CompanyRow;
  /** The company's card. Must belong to `company`; refused otherwise. */
  readonly card: CardRow;
  /** The card's limit for the current window. Must belong to `card`. */
  readonly spendLimit: SpendLimitRow;
  /**
   * The card's transactions, in any order. Both filters that decide what
   * counts against the cap are applied here, so a caller is free to scope this
   * to the current window or to hand over everything it holds.
   */
  readonly transactions: readonly TransactionRow[];
  /**
   * How many transactions the company has in total — a separate figure because
   * `transactions` above is whatever the caller loaded, and the screen's
   * `N more items` counts the whole collection.
   */
  readonly transactionCount: number;
}

/**
 * A `companies` row as the selector lists it.
 *
 * Two of the table's five columns. The registered legal name, the organisation
 * number and the default currency are all facts the provider holds and none of
 * them is drawn on this screen — a derived schema would publish all five
 * because they happen to be there, and every one would become a fact consumers
 * depend on.
 */
export function toCompanySummary(row: CompanyRow): CompanySummary {
  return {
    id: row.id,
    name: row.displayName,
  };
}

/**
 * The settled spend booked inside the current window, in minor units.
 *
 * Exported because it is the rule the remaining figure rests on, and a case
 * that can name it directly is sharper than one that can only read the
 * subtraction's result. See the module header for both filters and for why the
 * sign is kept.
 */
export function settledSpendMinorUnits(
  transactions: readonly TransactionRow[],
  periodStartedAt: Date,
): number {
  return transactions
    .filter(
      (row) => row.settlementState === COUNTED_SETTLEMENT_STATE
        && row.bookedAt >= periodStartedAt,
    )
    .reduce((total, row) => total + row.amountMinorUnits, NO_SPEND_MINOR_UNITS);
}

/**
 * The transactions the screen lists: the newest first, capped at what the
 * contract says the provider will send.
 *
 * Sorted here rather than trusted from the caller. `Dashboard` publishes
 * "newest first" and this function is what produces that payload, so holding
 * the order is cheaper than a precondition every caller has to remember. The
 * sort is on a copy — the caller's array is never reordered — and is stable,
 * so two rows booked at the same instant keep the order they arrived in.
 */
function latestTransactions(
  transactions: readonly TransactionRow[],
): ContractTransaction[] {
  return [...transactions]
    .sort((left, right) => right.bookedAt.getTime() - left.bookedAt.getTime())
    .slice(0, DASHBOARD_TRANSACTION_COUNT)
    .map(toContractTransaction);
}

/**
 * Refuses four rows that do not belong together.
 *
 * Nothing else in the request path checks this. The repository reads each row
 * by its own key, and a wiring mistake in the route would otherwise render one
 * card's spend against another card's cap — a number that looks entirely
 * plausible on the screen and is wrong. It throws for the reason
 * `resolveCardArtUrl` throws on a bad art base: reaching it means the provider
 * is misassembled, and Express turns the throw into a `500` rather than
 * publishing a payload nobody can act on.
 *
 * The transactions are not checked row by row. The caller scopes that query by
 * company and the check would be a per-row cost on the one input that grows.
 */
function assertRowsBelongTogether(sources: DashboardSources): void {
  if (sources.card.companyId !== sources.company.id) {
    throw new Error(
      `card '${sources.card.id}' belongs to company '${sources.card.companyId}', `
      + `not to '${sources.company.id}'`,
    );
  }

  if (sources.spendLimit.cardId !== sources.card.id) {
    throw new Error(
      `spend limit belongs to card '${sources.spendLimit.cardId}', `
      + `not to '${sources.card.id}'`,
    );
  }
}

/**
 * Everything the mobile view renders, in one response.
 *
 * `remaining` is signed: a card whose settled spend has overrun its cap
 * reports a negative figure rather than a clamped zero that hides the overrun,
 * which is what `SpendSummary` promises by publishing a `MonetaryAmount`.
 *
 * `furtherTransactionCount` is floored at zero. A total smaller than the rows
 * that were listed is an inconsistent caller, and publishing the negative
 * would break the contract's `minimum: 0` for every consumer — the fault stays
 * the caller's rather than becoming the consumer's.
 */
export function toDashboard(
  sources: DashboardSources,
  options: CardMappingOptions,
): Dashboard {
  assertRowsBelongTogether(sources);

  const currency = sources.company.defaultCurrencyCode;
  const spent = settledSpendMinorUnits(
    sources.transactions,
    sources.spendLimit.periodStartedAt,
  );
  const remaining: MonetaryAmount = {
    minorUnits: sources.spendLimit.capMinorUnits - spent,
    currency,
  };
  const listed = latestTransactions(sources.transactions);

  return {
    company: toCompanySummary(sources.company),
    card: toContractCard(sources.card, options),
    spend: {
      remaining,
      limit: { minorUnits: sources.spendLimit.capMinorUnits, currency },
    },
    latestTransactions: listed,
    furtherTransactionCount: Math.max(
      NO_FURTHER_TRANSACTIONS,
      sources.transactionCount - listed.length,
    ),
  };
}
