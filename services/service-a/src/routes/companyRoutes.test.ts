/**
 * The three company-scoped reads, against a real Postgres.
 *
 * `routes/router.test.ts` already pins what every route does before it reads
 * anything — the operation it records, and the `400` it answers an invalid
 * request with — using a database handle that throws on contact. What is left
 * is everything downstream of a read, and none of it can be claimed without a
 * server:
 *
 * - **The dashboard payload is the mobile view.** `5 400/10 000 kr` and
 *   `54 more items` are what the screenshot in `assets/mobile-view.png`
 *   renders, and this is the first place in the repo where they are produced
 *   by the whole path — seed, migration, repository, mapper, route — rather
 *   than by a mapper handed fixture rows.
 * - **A page is the page that was asked for.** `limit` and `offset` have to
 *   reach SQL and come back in `page`, and `total` has to count the collection
 *   rather than the page.
 * - **An unknown company is a `404`, not an empty page.** An empty page is a
 *   real answer for a company with no transactions, so a route that let both
 *   mean the same thing would tell a consumer nothing.
 * - **An identifier this provider could not have issued costs no read.** That
 *   is asserted against a database that throws on contact, which is the only
 *   way to state "before" rather than "and also".
 *
 * The `200` payloads are asserted whole, with `toStrictEqual`. Their *shape*
 * is already pinned by `tsc` against the contract's own static types — a body
 * that is not the published shape fails `bun run check-types` in
 * `companyRoutes.ts` — so what a case adds is the values, and `toStrictEqual`
 * additionally distinguishes an absent key from a present-and-`undefined` one,
 * which is spec section 2.5's absent-not-null convention.
 *
 * Response payloads are deliberately **not** re-validated with
 * `Value.Check(Dashboard, ...)`: it throws `Unknown type`, because the
 * contract's enums are `Type.Unsafe` and TypeBox attaches no kind to one. See
 * `requestParsing.ts`'s header.
 */
import type { RouteDependencies } from './dependencies';
import type { ServiceDatabase } from '../repositories/database';
import type { SeededPostgres } from '../testing/seededDatabase';
import type {
  CompanyList,
  Dashboard,
  ErrorResponse,
  TransactionList,
} from '@marcos-corp/contracts-service-a';

import { PAGE_LIMIT_DEFAULT } from '@marcos-corp/contracts-service-a';
import { SEED_COMPANY_ID, SEED_FIGURES } from '@marcos-corp/db/seed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { invokeRoute } from '../testing/routeInvocation';
import {
  SEED_NOW,
  SEEDED_DATABASE_TIMEOUT_MS,
  startSeededDatabase,
} from '../testing/seededDatabase';

import {
  getCompanyDashboardRoute,
  listCompaniesRoute,
  listCompanyTransactionsRoute,
} from './companyRoutes';

/** Where `server.ts` will say card artwork is served from. */
const ART_BASE_URL = 'https://cdn.example.com/assets';

/** A legal identifier of the issued shape that names no row. */
const UNKNOWN_COMPANY_ID = '99999999-9999-4999-8999-999999999999';

/** A shape this provider has never issued, so no read is worth making. */
const UNISSUABLE_COMPANY_ID = 'not-a-uuid';

let postgres: SeededPostgres;
let deps: RouteDependencies;

/**
 * Dependencies whose database throws on contact.
 *
 * The cases that use it assert a route answered *without* reading, which a
 * seeded database cannot distinguish from a route that read and then answered
 * the same way.
 */
const UNREACHABLE: RouteDependencies = {
  db: new Proxy({}, {
    get(_target, property) {
      throw new Error(`this case may not reach the database, and it read '${String(property)}'`);
    },
  }) as ServiceDatabase,
  cardMapping: { artBaseUrl: ART_BASE_URL },
  now: () => SEED_NOW,
};

function dependenciesFor(db: ServiceDatabase): RouteDependencies {
  return { db, cardMapping: { artBaseUrl: ART_BASE_URL }, now: () => SEED_NOW };
}

beforeAll(async () => {
  postgres = await startSeededDatabase();
  deps = dependenciesFor(postgres.db);
}, SEEDED_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await postgres?.stop();
});

describe('listCompanies', () => {
  it('answers the seeded company, with the contract\'s default page applied', async () => {
    const answer = await invokeRoute<CompanyList>(listCompaniesRoute(deps));

    expect(answer.status).toBe(200);
    expect(answer.body).toStrictEqual({
      items: [{ id: SEED_COMPANY_ID, name: 'Company AB' }],
      page: { limit: PAGE_LIMIT_DEFAULT, offset: 0, total: 1 },
    });
  });

  it('publishes two of the table\'s columns and nothing else', async () => {
    // The concrete half of spec section 2.1: a schema derived from `companies`
    // would publish the registered legal name, the organisation number and the
    // default currency because they happen to be there.
    const answer = await invokeRoute<CompanyList>(listCompaniesRoute(deps));
    const [company] = answer.body.items;

    expect(Object.keys(company ?? {})).toStrictEqual(['id', 'name']);
  });

  it('applies the limit and offset it was asked for', async () => {
    const answer = await invokeRoute<CompanyList>(listCompaniesRoute(deps), {
      query: { limit: '1', offset: '1' },
    });

    expect(answer.body.items).toStrictEqual([]);
    expect(answer.body.page).toStrictEqual({ limit: 1, offset: 1, total: 1 });
  });

  it('reports the collection total, not the page length', async () => {
    // The case above runs the offset past the end, so `items` is empty while
    // `total` must still be 1. A `total` computed from the page would be 0.
    const answer = await invokeRoute<CompanyList>(listCompaniesRoute(deps), {
      query: { limit: '1', offset: '1' },
    });

    expect(answer.body.page.total).toBe(1);
  });

  it('answers an empty page for a database with no companies', async () => {
    const empty = await postgres.createEmptyDatabase();

    const answer = await invokeRoute<CompanyList>(
      listCompaniesRoute(dependenciesFor(empty)),
    );

    expect(answer.status).toBe(200);
    expect(answer.body.items).toStrictEqual([]);
    expect(answer.body.page.total).toBe(0);
  });
});

describe('getCompanyDashboard', () => {
  it('answers the whole mobile view for the seeded company', async () => {
    const answer = await invokeRoute<Dashboard>(getCompanyDashboardRoute(deps), {
      params: { companyId: SEED_COMPANY_ID },
    });

    expect(answer.status).toBe(200);
    expect(answer.body.company).toStrictEqual({
      id: SEED_COMPANY_ID,
      name: 'Company AB',
    });
    expect(answer.body.spend).toStrictEqual({
      remaining: {
        minorUnits: SEED_FIGURES.remainingSpendMinorUnits,
        currency: SEED_FIGURES.currencyCode,
      },
      limit: {
        minorUnits: SEED_FIGURES.spendCapMinorUnits,
        currency: SEED_FIGURES.currencyCode,
      },
    });
  });

  it('reads 5 400 of 10 000 kr, the figures on the screenshot', async () => {
    // Pinned as literals as well as against `SEED_FIGURES`, because the seed
    // and the screenshot are two sources that have to agree and a check
    // against the seed alone moves with it.
    const answer = await invokeRoute<Dashboard>(getCompanyDashboardRoute(deps), {
      params: { companyId: SEED_COMPANY_ID },
    });

    expect(answer.body.spend.remaining.minorUnits).toBe(540_000);
    expect(answer.body.spend.limit.minorUnits).toBe(1_000_000);
  });

  it('lists three transactions and reports 54 more', async () => {
    const answer = await invokeRoute<Dashboard>(getCompanyDashboardRoute(deps), {
      params: { companyId: SEED_COMPANY_ID },
    });

    expect(answer.body.latestTransactions).toHaveLength(3);
    expect(answer.body.furtherTransactionCount).toBe(54);
  });

  it('lists them newest first', async () => {
    const answer = await invokeRoute<Dashboard>(getCompanyDashboardRoute(deps), {
      params: { companyId: SEED_COMPANY_ID },
    });
    const bookedAt = answer.body.latestTransactions.map((row) => row.bookedAt);

    expect(bookedAt).toStrictEqual([...bookedAt].sort().reverse());
  });

  it('answers the card as the contract publishes it, with no null activatedAt', async () => {
    // The seed leaves the card `issued`, so `activated_at` is null in the row
    // and the key must be absent from the payload rather than present and
    // null (spec section 2.5). `toStrictEqual` is what sees the difference.
    const answer = await invokeRoute<Dashboard>(getCompanyDashboardRoute(deps), {
      params: { companyId: SEED_COMPANY_ID },
    });

    expect(answer.body.card).toStrictEqual({
      id: '22222222-2222-4222-8222-222222222222',
      lastFour: '4321',
      state: 'inactive',
      artUrl: `${ART_BASE_URL}/card-art/business-black-v2.png`,
    });
    expect('activatedAt' in answer.body.card).toBe(false);
  });

  it('answers 404 for a legal identifier that names no company', async () => {
    const answer = await invokeRoute<ErrorResponse>(getCompanyDashboardRoute(deps), {
      params: { companyId: UNKNOWN_COMPANY_ID },
    });

    expect(answer.status).toBe(404);
    expect(answer.body.code).toBe('not_found');
  });

  it('answers 404 for an unissuable identifier without reading anything', async () => {
    const answer = await invokeRoute<ErrorResponse>(
      getCompanyDashboardRoute(UNREACHABLE),
      { params: { companyId: UNISSUABLE_COMPANY_ID } },
    );

    expect(answer.status).toBe(404);
    expect(answer.body.code).toBe('not_found');
  });

  it('answers 404 for a company that exists and holds no card', async () => {
    // The route has to distinguish this from "no such company" internally and
    // must not distinguish it in the answer: the contract publishes no
    // dashboard shape without a card.
    const empty = await postgres.createEmptyDatabase();
    await empty.execute(
      `insert into companies (id, registered_legal_name, display_name, organisation_number, default_currency_code)
       values ('${UNKNOWN_COMPANY_ID}', 'Cardless Sverige AB', 'Cardless AB', '200000-0009', 'SEK')`,
    );

    const answer = await invokeRoute<ErrorResponse>(
      getCompanyDashboardRoute(dependenciesFor(empty)),
      { params: { companyId: UNKNOWN_COMPANY_ID } },
    );

    expect(answer.status).toBe(404);
    expect(answer.body.code).toBe('not_found');
    expect(answer.body.message).toContain('no card');
  });

  it('answers 400 for a path parameter the contract refuses', async () => {
    const answer = await invokeRoute<ErrorResponse>(getCompanyDashboardRoute(deps), {
      params: { companyId: '' },
    });

    expect(answer.status).toBe(400);
    expect(answer.body.fields).toStrictEqual(['companyId']);
  });
});

describe('listCompanyTransactions', () => {
  it('answers the first page of the seeded 57, newest first', async () => {
    const answer = await invokeRoute<TransactionList>(
      listCompanyTransactionsRoute(deps),
      { params: { companyId: SEED_COMPANY_ID } },
    );

    expect(answer.status).toBe(200);
    expect(answer.body.items).toHaveLength(PAGE_LIMIT_DEFAULT);
    expect(answer.body.page).toStrictEqual({
      limit: PAGE_LIMIT_DEFAULT,
      offset: 0,
      total: SEED_FIGURES.transactionCount,
    });
  });

  it('pages to the end of the collection', async () => {
    const answer = await invokeRoute<TransactionList>(
      listCompanyTransactionsRoute(deps),
      { params: { companyId: SEED_COMPANY_ID }, query: { limit: '20', offset: '40' } },
    );

    expect(answer.body.items).toHaveLength(SEED_FIGURES.transactionCount - 40);
    expect(answer.body.page.total).toBe(SEED_FIGURES.transactionCount);
  });

  it('hands each row to a consumer exactly once across the pages', async () => {
    // Offset paging over an unstable sort silently returns one row on two
    // pages and skips another, and every individual page still looks correct.
    const pages = await Promise.all([0, 20, 40].map(async (offset) => invokeRoute<TransactionList>(
      listCompanyTransactionsRoute(deps),
      { params: { companyId: SEED_COMPANY_ID }, query: { limit: '20', offset: String(offset) } },
    )));
    const ids = pages.flatMap((page) => page.body.items.map((row) => row.id));

    expect(ids).toHaveLength(SEED_FIGURES.transactionCount);
    expect(new Set(ids).size).toBe(SEED_FIGURES.transactionCount);
  });

  it('publishes money as an object, not as the two columns behind it', async () => {
    // `transactions` stores `amount_minor_units` and `currency_code` flat; the
    // contract publishes one `MonetaryAmount`. The structural half of the
    // divergence spec section 2.1 rests on.
    const answer = await invokeRoute<TransactionList>(
      listCompanyTransactionsRoute(deps),
      { params: { companyId: SEED_COMPANY_ID }, query: { limit: '1' } },
    );
    const [transaction] = answer.body.items;

    expect(transaction?.amount.currency).toBe(SEED_FIGURES.currencyCode);
    expect(typeof transaction?.amount.minorUnits).toBe('number');
    expect(Object.keys(transaction ?? {})).not.toContain('merchantCategoryCode');
  });

  it('answers 404 for a legal identifier that names no company', async () => {
    // Rather than an empty page: an empty page is a real answer for a company
    // whose card has never been used, so the two must not collapse.
    const answer = await invokeRoute<ErrorResponse>(
      listCompanyTransactionsRoute(deps),
      { params: { companyId: UNKNOWN_COMPANY_ID } },
    );

    expect(answer.status).toBe(404);
    expect(answer.body.code).toBe('not_found');
  });

  it('answers 404 for an unissuable identifier without reading anything', async () => {
    const answer = await invokeRoute<ErrorResponse>(
      listCompanyTransactionsRoute(UNREACHABLE),
      { params: { companyId: UNISSUABLE_COMPANY_ID } },
    );

    expect(answer.status).toBe(404);
  });

  it('answers 400 for an unknown query field, naming it', async () => {
    const answer = await invokeRoute<ErrorResponse>(
      listCompanyTransactionsRoute(deps),
      { params: { companyId: SEED_COMPANY_ID }, query: { limit: '5', sort: 'oldest' } },
    );

    expect(answer.status).toBe(400);
    expect(answer.body.fields).toStrictEqual(['sort']);
  });

  it('accepts the same request without the unknown field', async () => {
    // The positive control for the case above: without it, a route that
    // refused every query would pass.
    const answer = await invokeRoute<TransactionList>(
      listCompanyTransactionsRoute(deps),
      { params: { companyId: SEED_COMPANY_ID }, query: { limit: '5' } },
    );

    expect(answer.status).toBe(200);
    expect(answer.body.items).toHaveLength(5);
  });
});
