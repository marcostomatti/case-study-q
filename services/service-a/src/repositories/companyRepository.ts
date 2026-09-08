/**
 * Reads on `companies`: the row the dashboard is scoped by, and the page the
 * company selector at the top of the mobile view renders.
 *
 * Every function here returns the **Drizzle row type**, not a contract type.
 * That boundary is the whole reason this layer and the mapping layer are
 * separate files: a repository that returned `CompanySummary` would decide
 * which two of the table's five columns a consumer sees, and the decision
 * would then live in a query rather than in `mapping/dashboardMapper.ts` where
 * spec section 2.1's argument is written down. Reading a column here is free;
 * publishing one is a contract change.
 *
 * ## "Companies the caller may act for" is every company, in this PoC
 *
 * The contract says the selector lists the companies the caller may act for,
 * and this implementation lists all of them. There is no per-consumer company
 * scoping in the schema — `api_usage` records which `client_id` called which
 * operation, and nothing anywhere maps a `client_id` to a set of companies.
 *
 * Stated here rather than left to be inferred from a missing `WHERE`, because
 * the two are indistinguishable in code and only one of them is deliberate.
 * Adding the scope later is a change to this function and to the registry in
 * `auth/clientIdentity.ts`; it is **not** a contract change, which is the
 * property that makes leaving it out safe rather than merely convenient.
 */
import type { ServiceDatabase } from './database';
import type { Page, PageRequest } from './pagination';
import type { Company } from '@marcos-corp/db';

import { companies } from '@marcos-corp/db';
import { asc, count, eq } from 'drizzle-orm';

import { assertPageRequest, readTotal } from './pagination';

/** A lookup by primary key returns at most one row. */
const ONE_ROW = 1;

/**
 * The one company behind an identifier, or `null` when there is none.
 *
 * `null` rather than a throw: "no such company" is the contract's `404`, which
 * is an ordinary answer a consumer branches on, and turning it into an
 * exception here would make every caller's happy path the catch block. The
 * gates in this repo draw the same line — a bad input is a returned finding, a
 * gate that cannot run is a throw.
 */
export async function findCompanyById(
  db: ServiceDatabase,
  companyId: string,
): Promise<Company | null> {
  const rows = await db
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(ONE_ROW);

  return rows[0] ?? null;
}

/**
 * One page of companies, plus how many there are in total.
 *
 * Ordered by the name the selector renders, with the identifier as a
 * tie-break. The tie-break is not decoration: two companies sharing a display
 * name is entirely possible — `display_name` carries no unique constraint,
 * unlike `organisation_number` — and without a total order Postgres is free to
 * return the same row on two consecutive pages and skip a third. Offset paging
 * over an unstable sort silently loses rows, and the loss is invisible in any
 * single response.
 *
 * The count is issued as its own statement rather than as a window function
 * beside the page. Two round trips at this size is not a cost worth a
 * `count(*) OVER ()` on every returned row, and the separate statement is what
 * lets `total` stay correct when the page is empty because the offset ran past
 * the end.
 */
export async function listCompanies(
  db: ServiceDatabase,
  page: PageRequest,
): Promise<Page<Company>> {
  const { limit, offset } = assertPageRequest(page);

  const items = await db
    .select()
    .from(companies)
    .orderBy(asc(companies.displayName), asc(companies.id))
    .limit(limit)
    .offset(offset);

  const totals = await db.select({ total: count() }).from(companies);

  return { items, total: readTotal(totals) };
}
