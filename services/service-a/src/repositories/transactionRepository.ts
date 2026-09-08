/**
 * Reads on `transactions`: the page behind `54 more items in transaction
 * view`, the total that count is derived from, and the rows the
 * remaining-spend meter is computed over.
 *
 * ## Newest first, and what that ordering costs
 *
 * `packages/db` declares `transactions_company_id_booked_at_idx` **ascending**
 * even though every read here sorts newest first, because Drizzle renders
 * `.desc()` on an index column as `DESC NULLS LAST` and the planner matches a
 * pathkey literally — an index declared that way is unusable by a plain
 * `ORDER BY booked_at DESC`. This is the module that has to hold up its end of
 * that decision, so the ordering below is a bare `desc(...)` and never
 * `desc nulls last`.
 *
 * Measured against a real server with `enable_seqscan` and `enable_bitmapscan`
 * off, so the planner has to say which index access it would use:
 *
 *   ORDER BY booked_at DESC             Index Scan Backward, no sort node
 *   ORDER BY booked_at DESC, id DESC    Index Scan Backward + Incremental Sort
 *                                       (Presorted Key: booked_at)
 *   ORDER BY booked_at DESC NULLS LAST  forward Index Scan + a full Sort
 *
 * The tie-break on `id` is therefore not free, but it is nearly so: the
 * incremental sort only reorders inside a group of rows sharing an instant.
 * It is also not optional. Offset paging over an unstable sort silently
 * returns a row on two consecutive pages and skips another, and `booked_at`
 * carries no unique constraint — an acquirer booking a batch stamps them
 * identically. `transaction_repository.test.ts` pins all three plans, because
 * a comment claiming an index is used is exactly the claim that quietly stops
 * being true.
 *
 * ## Two scopes, and why they differ
 *
 * A spend limit belongs to a **card**, so the rows the meter subtracts have to
 * be that card's — a company's other card spending against this card's cap is
 * a wrong figure that looks entirely plausible. The transaction view the
 * dashboard links to is a **company** view, and the contract says so:
 * `listCompanyTransactions` is company-scoped and its `page.total` is what
 * `furtherTransactionCount` is derived from.
 *
 * So `findDashboardTransactions` is card-scoped and `countCompanyTransactions`
 * is company-scoped, on purpose. The two coincide while a company holds one
 * card, which is the model `Dashboard` publishes — it carries one card — and
 * what `packages/db`'s seed builds. A company holding two would need the
 * contract to say which card the meter reads before either this module or
 * `mapping/dashboardMapper.ts` could be right about it, and that is a contract
 * change rather than a query someone should quietly widen here.
 */
import type { ServiceDatabase } from './database';
import type { Page, PageRequest } from './pagination';
import type { Transaction } from '@marcos-corp/db';

import { transactions } from '@marcos-corp/db';
import { and, count, desc, eq, gte } from 'drizzle-orm';

import { assertPageRequest, readTotal } from './pagination';

/**
 * The order both list reads use: newest first, ties broken by identifier.
 *
 * Exported because it is a claim about this repository rather than an
 * implementation detail — `transactionRepository.test.ts` renders it to SQL
 * and confirms it carries no `nulls` qualifier, then explains that exact
 * clause against the real index. A second, hand-written copy of the clause in
 * the suite would agree with itself whatever this module does.
 *
 * Both entries are bare `desc(...)`. See the module header for the measured
 * plans, and `packages/db`'s `transactions` module for why the index is
 * declared ascending in the first place.
 */
export const NEWEST_FIRST = [
  desc(transactions.bookedAt),
  desc(transactions.id),
] as const;

/** Which company's transaction view. */
export interface CompanyTransactionCriteria {
  readonly companyId: string;
}

/** The rows one dashboard needs: its card's window, and its card's newest few. */
export interface DashboardTransactionCriteria {
  /** The scope every read in this service is authorised on. */
  readonly companyId: string;
  /** Whose cap the window rows are measured against. */
  readonly cardId: string;
  /**
   * The instant the current spend window opened —
   * `spend_limits.period_started_at`. Inclusive, matching
   * `mapping/dashboardMapper.ts`'s boundary: both sides of
   * `booked_at >= period_started_at` have to agree about the edge.
   */
  readonly bookedSince: Date;
  /**
   * How many of the newest rows to include regardless of the window.
   *
   * The screen lists three, and a card with nothing booked in the last month
   * still has to list its last three transactions — fetching only the window
   * would render an empty list beside a full meter. The caller passes
   * `DASHBOARD_TRANSACTION_COUNT` from the contract.
   */
  readonly listCount: number;
}

/**
 * How many transactions a company has, across every card and every state.
 *
 * Exported separately from `listCompanyTransactions` because the dashboard
 * needs the figure and not the page: `furtherTransactionCount` is
 * `total - 3`, and fetching a page to throw it away is a read nobody asked
 * for.
 */
export async function countCompanyTransactions(
  db: ServiceDatabase,
  companyId: string,
): Promise<number> {
  const totals = await db
    .select({ total: count() })
    .from(transactions)
    .where(eq(transactions.companyId, companyId));

  return readTotal(totals);
}

/**
 * One page of a company's transactions, newest first, plus the total.
 *
 * The total is the same figure `countCompanyTransactions` returns and is
 * computed by calling it, rather than by a second `count(*)` spelled out
 * again here. Two copies of a predicate that must match is how a page and its
 * total start disagreeing — and a `total` counted over a different filter than
 * the `items` is a bug no single response reveals.
 */
export async function listCompanyTransactions(
  db: ServiceDatabase,
  criteria: CompanyTransactionCriteria,
  page: PageRequest,
): Promise<Page<Transaction>> {
  const { limit, offset } = assertPageRequest(page);

  const items = await db
    .select()
    .from(transactions)
    .where(eq(transactions.companyId, criteria.companyId))
    .orderBy(...NEWEST_FIRST)
    .limit(limit)
    .offset(offset);

  return { items, total: await countCompanyTransactions(db, criteria.companyId) };
}

/**
 * Every row one dashboard needs, each row once.
 *
 * Two reads unioned rather than one: the card's rows inside the current spend
 * window, which is what the meter subtracts, and the card's newest
 * `listCount`, which is what the screen lists. Neither is a superset of the
 * other — a quiet month leaves the newest three outside the window, and a busy
 * one leaves most of the window off the list.
 *
 * **The de-duplication is load-bearing rather than tidiness.**
 * `mapping/dashboardMapper.ts` sums the array it is handed, so a row appearing
 * in both halves would be counted against the cap twice and the meter would
 * read low by exactly that amount — a figure that looks entirely plausible on
 * the screen. Keyed on the primary key, keeping the first occurrence, so the
 * window rows win and the result is stable.
 *
 * The order of the returned array is deliberately not part of the answer. The
 * mapper sorts what it lists and filters what it sums, precisely so a caller
 * cannot get either wrong; see its `latestTransactions`.
 */
export async function findDashboardTransactions(
  db: ServiceDatabase,
  criteria: DashboardTransactionCriteria,
): Promise<Transaction[]> {
  const scope = and(
    eq(transactions.companyId, criteria.companyId),
    eq(transactions.cardId, criteria.cardId),
  );

  const inWindow = await db
    .select()
    .from(transactions)
    .where(and(scope, gte(transactions.bookedAt, criteria.bookedSince)));

  const newest = await db
    .select()
    .from(transactions)
    .where(scope)
    .orderBy(...NEWEST_FIRST)
    .limit(criteria.listCount);

  const byId = new Map<string, Transaction>();
  for (const row of [...inWindow, ...newest]) {
    if (!byId.has(row.id)) {
      byId.set(row.id, row);
    }
  }

  return [...byId.values()];
}
