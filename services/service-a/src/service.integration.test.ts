/**
 * The whole service, over real HTTP, against a migrated and seeded Postgres.
 *
 * Every other suite in this package stops somewhere short of that. The route
 * suites call a ts-rest implementation directly, the repository suites reach a
 * database but no Express, and `server.test.ts` binds a real port against a
 * `Proxy` handle that refuses every read — deliberately, because its subject is
 * the mount order rather than a payload. What none of them can say is what a
 * consumer actually receives, and that is the only claim in this file.
 *
 * Four things, each of which is a line in the spec rather than a property of
 * this implementation:
 *
 * 1. **A request the provider cannot attribute is refused** (spec section 2.3).
 *    A `client_id` is *derived from credentials*, so a caller that presents
 *    none has no identity — and one that spells `client_id` into the request
 *    itself is refused twice over: unauthenticated without a credential, and
 *    an undeclared field with one.
 * 2. **A request carrying a field the contract does not declare is refused**
 *    (spec section 2.5, the strict half). Covered on both request parts this
 *    contract has: a query parameter and the one request body.
 * 3. **A well-formed dashboard request answers a payload the published
 *    document validates.** Against the emitted OpenAPI document, through
 *    `src/testing/publishedContract.ts`, whose header argues why not TypeBox.
 * 4. **The transaction view pages across all 57 seeded rows while the
 *    dashboard reports 54 further items** — the `5 400/10 000 kr` and
 *    `54 more items in transaction view` the mobile view renders.
 *
 * ## Every refusal here carries a positive control
 *
 * A suite made only of refusals passes against a service that refuses
 * everything, which is the failure mode a stack this deep is most likely to
 * have. So each case that asserts a rejection also drives the same request
 * along the one axis under test — the credential, the extra field — and
 * asserts it is *not* refused. Where the accepted request would change data,
 * the control is aimed at an identifier no row carries, so the acceptance
 * shows as a `404` from a lookup rather than as a write this suite would then
 * have to undo.
 *
 * ## What this suite is not
 *
 * It does not re-make the mapping layer's claims: `540000` is derived and
 * asserted per filter in `mapping/dashboardMapper.test.ts`, and the seed's own
 * figures are asserted against the screenshot in `packages/db`. What is new
 * here is that the number survives the whole path — repository, mapper, route,
 * Express, JSON — and arrives in a payload the published document accepts.
 */
import type { RegisteredConsumer } from './auth/clientIdentity';
import type { RunningService } from './server';
import type { PublishedContract } from './testing/publishedContract';
import type { SeededPostgres } from './testing/seededDatabase';
import type {
  Dashboard,
  ErrorResponse,
  TransactionList,
} from '@marcos-corp/contracts-service-a';

import {
  DASHBOARD_TRANSACTION_COUNT,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
} from '@marcos-corp/contracts-service-a';
import { SEED_CARD_ID, SEED_COMPANY_ID, SEED_FIGURES } from '@marcos-corp/db/seed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fingerprintCredential } from './auth/clientIdentity';
import { loadServiceEnv } from './config/env';
import { createServiceApp, EPHEMERAL_PORT, startHttpServer } from './server';
import { loadPublishedContract } from './testing/publishedContract';
import {
  SEED_NOW,
  SEEDED_DATABASE_TIMEOUT_MS,
  startSeededDatabase,
} from './testing/seededDatabase';

/**
 * The figures read off `assets/mobile-view.png`, restated here rather than
 * imported.
 *
 * `SEED_FIGURES` is asserted *against* these below, so a seed edited to agree
 * with a changed implementation fails rather than passes. Same argument
 * `packages/db`'s own integration suite makes, and the reason both copies
 * exist: a suite that imports the number it is checking agrees with itself.
 */
const MOBILE_VIEW = {
  /** `5 400/10 000 kr` — the figure the meter leads with. */
  remainingSpendMinorUnits: 540_000,
  /** The `10 000` half of it. */
  spendCapMinorUnits: 1_000_000,
  currencyCode: 'SEK',
  companyName: 'Company AB',
  cardLastFour: '4321',
  /** Rows under "Latest transactions". */
  shownTransactionCount: 3,
  /** `54 more items in transaction view`. */
  furtherTransactionCount: 54,
} as const;

/** 3 shown + 54 more. Derived, so the two halves cannot drift apart. */
const MOBILE_VIEW_TRANSACTION_COUNT
  = MOBILE_VIEW.shownTransactionCount + MOBILE_VIEW.furtherTransactionCount;

/**
 * The version this deployment states, and the version the emitted document
 * publishes.
 *
 * Deliberately the same number, and asserted equal below. `config/env.ts`
 * keeps the two independent on purpose — a build must keep reporting the
 * version it was built from after the tree moves on — but a suite validating
 * payloads against a document some *other* build published would be proving
 * nothing, so this one stands the service up on the version in the tree and
 * says so.
 */
const SERVED_CONTRACT_VERSION = '0.1.0';

/** Never reached: nothing here goes through `startService`. */
const DATABASE_URL = 'postgres://service_a:unused@127.0.0.1:5432/service_a';

const CARD_MAPPING = { artBaseUrl: 'https://cdn.example.com/card-art' };

const WEB_B_CREDENTIAL = 'qc_live_2a6d0f83b41c9e7d5028af61c3b94e70';

const WEB_B: RegisteredConsumer = {
  clientId: 'web-b',
  owner: 'team-b',
  credentialSha256: fingerprintCredential(WEB_B_CREDENTIAL),
};

/** A legal identifier no seeded row carries, so it reaches a lookup. */
const UNKNOWN_COMPANY_ID = '99999999-9999-4999-8999-999999999999';
const UNKNOWN_CARD_ID = '88888888-8888-4888-8888-888888888888';

/** What the activation body has to carry, and the only request body there is. */
const ACTIVATION_BODY = { confirmedLastFour: MOBILE_VIEW.cardLastFour };

let postgres: SeededPostgres;
let service: RunningService;
let published: PublishedContract;

beforeAll(async () => {
  postgres = await startSeededDatabase();
  published = loadPublishedContract();

  const app = createServiceApp({
    env: loadServiceEnv({ DATABASE_URL, PORT: '4001', CONTRACT_VERSION: SERVED_CONTRACT_VERSION }),
    db: postgres.db,
    consumers: [WEB_B],
    cardMapping: CARD_MAPPING,
    // Fixed to the instant the seed measured its rows back from, so the spend
    // window the dashboard reads is the one the seed wrote against. The wall
    // clock would move the window under the suite and read a different meter
    // on a slow enough run.
    now: () => SEED_NOW,
  });

  service = await startHttpServer(app, { port: EPHEMERAL_PORT });
}, SEEDED_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await service?.close();
  await postgres?.stop();
});

interface Answer<Body> {
  readonly status: number;
  readonly body: Body;
  readonly headers: Headers;
}

/** A request carrying whatever headers it was given, and nothing else. */
async function call<Body>(
  path: string,
  init: Parameters<typeof fetch>[1] = {},
): Promise<Answer<Body>> {
  const response = await fetch(`${service.url}${path}`, init);

  return {
    status: response.status,
    body: await response.json() as Body,
    headers: response.headers,
  };
}

/** The same request, presenting the credential `web-b` was issued. */
async function callAsWebB<Body>(
  path: string,
  init: Parameters<typeof fetch>[1] = {},
): Promise<Answer<Body>> {
  return call<Body>(path, {
    ...init,
    headers: {
      authorization: `Bearer ${WEB_B_CREDENTIAL}`,
      'x-consumer-package': '@marcos-corp/web-b',
      ...init?.headers,
    },
  });
}

/** A JSON `POST`, for the one operation that takes a body. */
function postingJson(body: unknown): Parameters<typeof fetch>[1] {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const DASHBOARD_PATH = `/companies/${SEED_COMPANY_ID}/dashboard`;
const TRANSACTIONS_PATH = `/companies/${SEED_COMPANY_ID}/transactions`;
const ACTIVATION_PATH
  = `/companies/${UNKNOWN_COMPANY_ID}/cards/${UNKNOWN_CARD_ID}/activation`;

describe('the seed this suite reads, against the screen it was built from', () => {
  it('carries the figures the mobile view renders', () => {
    // Not a tautology and not this service's claim: it is the guard that stops
    // every case below from being a statement about whatever the seed happens
    // to hold today. `packages/db` owns the derivation; this owns the pin.
    expect(SEED_FIGURES.remainingSpendMinorUnits)
      .toBe(MOBILE_VIEW.remainingSpendMinorUnits);
    expect(SEED_FIGURES.spendCapMinorUnits).toBe(MOBILE_VIEW.spendCapMinorUnits);
    expect(SEED_FIGURES.currencyCode).toBe(MOBILE_VIEW.currencyCode);
    expect(SEED_FIGURES.transactionCount).toBe(MOBILE_VIEW_TRANSACTION_COUNT);
    expect(SEED_FIGURES.furtherTransactionCount)
      .toBe(MOBILE_VIEW.furtherTransactionCount);
    expect(DASHBOARD_TRANSACTION_COUNT).toBe(MOBILE_VIEW.shownTransactionCount);
  });
});

describe('a request the provider cannot attribute to a client_id', () => {
  it('refuses a request carrying no credential, and answers the same one that does', async () => {
    const refused = await call<ErrorResponse>(DASHBOARD_PATH);

    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('unauthenticated');
    expect(refused.headers.get('www-authenticate')).toBe('Bearer realm="service-a"');

    // The control, along the one axis under test: the identical request with
    // a credential is answered, so the refusal above is the missing credential
    // rather than a stack that refuses everything.
    const answered = await callAsWebB<Dashboard>(DASHBOARD_PATH);
    expect(answered.status).toBe(200);
  });

  it('refuses a credential no consumer holds, and says which kind of refusal', async () => {
    const { status, body, headers } = await call<ErrorResponse>(DASHBOARD_PATH, {
      headers: { authorization: 'Bearer qc_live_0000000000000000000000000000000000' },
    });

    expect(status).toBe(401);
    expect(body.code).toBe('unauthenticated');
    expect(headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('will not take a client_id the caller declares for itself', async () => {
    // Spec section 2.3's actual content, and the reason it says *derived from*
    // credentials: an identity a caller states is worth exactly what a
    // `User-Agent` is. Refused twice over — as unauthenticated without a
    // credential, and as an undeclared field with one.
    const declared = await call<ErrorResponse>(`${TRANSACTIONS_PATH}?client_id=web-b`);
    expect(declared.status).toBe(401);
    expect(declared.body.code).toBe('unauthenticated');

    const authenticated
      = await callAsWebB<ErrorResponse>(`${TRANSACTIONS_PATH}?client_id=web-b`);
    expect(authenticated.status).toBe(400);
    expect(authenticated.body.code).toBe('validation_failed');
  });
});

describe('a request carrying a field the contract does not declare', () => {
  it('refuses an undeclared query parameter, and answers the same query without it', async () => {
    const refused = await callAsWebB<ErrorResponse>(`${TRANSACTIONS_PATH}?bogus=1`);

    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('validation_failed');
    expect(refused.body.fields).toContain('bogus');

    // The control: the same operation, the same caller, one field fewer.
    const answered = await callAsWebB<TransactionList>(TRANSACTIONS_PATH);
    expect(answered.status).toBe(200);
  });

  it('refuses an undeclared field beside a declared one', async () => {
    // `limit` is real and legal here, so the refusal cannot be about the query
    // being unrecognisable — it is about the one key that is not published.
    const { status, body } = await callAsWebB<ErrorResponse>(
      `${TRANSACTIONS_PATH}?limit=5&clientId=web-b`,
    );

    expect(status).toBe(400);
    expect(body.fields).toContain('clientId');
    expect(body.fields).not.toContain('limit');
  });

  it('refuses an undeclared field in the request body, and takes the same body without it', async () => {
    // The other request part, and a different code path — `parseRequestPayload`
    // rather than `parseQueryParameters`. Aimed at identifiers no row carries,
    // so the control's acceptance shows as a lookup failing rather than as a
    // card this suite would then have to un-activate.
    const refused = await callAsWebB<ErrorResponse>(
      ACTIVATION_PATH,
      postingJson({ ...ACTIVATION_BODY, clientId: 'web-b' }),
    );

    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('validation_failed');
    expect(refused.body.fields).toContain('clientId');

    // The control: the same request minus that key reaches the lookup, which
    // is how a `404` proves the body was accepted.
    const accepted = await callAsWebB<ErrorResponse>(
      ACTIVATION_PATH,
      postingJson(ACTIVATION_BODY),
    );
    expect(accepted.status).toBe(404);
    expect(accepted.body.code).toBe('not_found');
  });
});

describe('the dashboard, as the mobile view renders it', () => {
  it('answers a payload the published document validates', async () => {
    const { status, body } = await callAsWebB<Dashboard>(DASHBOARD_PATH);
    const checked = published.checkResponse('getCompanyDashboard', status, body);

    expect(status).toBe(200);
    expect(checked.problems).toEqual([]);
    expect(checked.ok).toBe(true);
  });

  it('validates against the schema the document names for this operation', async () => {
    // Which schema was read is otherwise invisible: a validator pointed at the
    // wrong component passes just as quietly as one pointed at the right one.
    expect(published.responseSchemaRef('getCompanyDashboard', 200))
      .toMatch(/#\/components\/schemas\/Dashboard$/);
    expect(published.documentPath)
      .toMatch(/packages\/contracts-service-a\/openapi\/openapi\.json$/);
    expect(published.version).toBe(SERVED_CONTRACT_VERSION);
  });

  it('refuses the same payload once a published constraint is broken', async () => {
    // The control for the two cases above. A validator that read nothing
    // reports every payload as valid, and "valid" is the same word either way.
    const { body } = await callAsWebB<Dashboard>(DASHBOARD_PATH);
    const outsideTheCatalogue = {
      ...body,
      card: { ...body.card, state: 'not-a-published-state' },
    };

    const checked = published.checkResponse('getCompanyDashboard', 200, outsideTheCatalogue);

    expect(checked.ok).toBe(false);
    expect(checked.problems.join(' ')).toContain('/card/state');
  });

  it('reads 5 400 of 10 000 kr, the meter the screen leads with', async () => {
    const { body } = await callAsWebB<Dashboard>(DASHBOARD_PATH);

    expect(body.spend).toStrictEqual({
      remaining: {
        minorUnits: MOBILE_VIEW.remainingSpendMinorUnits,
        currency: MOBILE_VIEW.currencyCode,
      },
      limit: {
        minorUnits: MOBILE_VIEW.spendCapMinorUnits,
        currency: MOBILE_VIEW.currencyCode,
      },
    });
  });

  it('lists three transactions and reports 54 more', async () => {
    const { body } = await callAsWebB<Dashboard>(DASHBOARD_PATH);

    expect(body.latestTransactions).toHaveLength(MOBILE_VIEW.shownTransactionCount);
    expect(body.furtherTransactionCount).toBe(MOBILE_VIEW.furtherTransactionCount);
  });

  it('names the company the selector shows and the card the screen renders', async () => {
    const { body } = await callAsWebB<Dashboard>(DASHBOARD_PATH);

    expect(body.company).toStrictEqual({
      id: SEED_COMPANY_ID,
      name: MOBILE_VIEW.companyName,
    });
    expect(body.card.id).toBe(SEED_CARD_ID);
    expect(body.card.lastFour).toBe(MOBILE_VIEW.cardLastFour);
    // The seeded card is `issued`, so the screen's "Activate card" action has
    // something to do — and `activatedAt` is absent rather than null.
    expect(body.card.state).toBe('inactive');
    expect('activatedAt' in body.card).toBe(false);
  });
});

describe('the transaction view behind 54 more items', () => {
  /** Every page, walked with the caller's own page size. */
  async function walk(limit: number): Promise<TransactionList[]> {
    const pages: TransactionList[] = [];

    for (let offset = 0; ; offset += limit) {
      const { status, body } = await callAsWebB<TransactionList>(
        `${TRANSACTIONS_PATH}?limit=${String(limit)}&offset=${String(offset)}`,
      );
      expect(status).toBe(200);
      pages.push(body);

      if (offset + limit >= body.page.total) {
        return pages;
      }
    }
  }

  it('pages across all 57 seeded transactions without losing or repeating one', async () => {
    const pages = await walk(PAGE_LIMIT_DEFAULT);
    const items = pages.flatMap((page) => page.items);
    const identifiers = new Set(items.map((transaction) => transaction.id));

    expect(pages).toHaveLength(3);
    expect(pages.map((page) => page.items.length)).toEqual([20, 20, 17]);
    expect(items).toHaveLength(MOBILE_VIEW_TRANSACTION_COUNT);
    expect(identifiers.size).toBe(MOBILE_VIEW_TRANSACTION_COUNT);
  });

  it('reports the same total on every page', async () => {
    const pages = await walk(PAGE_LIMIT_DEFAULT);

    expect(pages.map((page) => page.page.total))
      .toEqual(pages.map(() => MOBILE_VIEW_TRANSACTION_COUNT));
    expect(pages.map((page) => page.page.offset)).toEqual([0, 20, 40]);
  });

  it('keeps one newest-first order across the page boundaries', async () => {
    // Offset paging over a partial order hands one row to two pages and skips
    // another, and every individual page still looks correct — which is why
    // both assertions below are over the concatenation rather than per page.
    const paged = (await walk(PAGE_LIMIT_DEFAULT)).flatMap((page) => page.items);
    const booked = paged.map((transaction) => transaction.bookedAt);
    const ascendingSteps = booked.filter((instant, index) => {
      const previous = booked[index - 1];
      return previous !== undefined && instant > previous;
    });

    expect(ascendingSteps).toEqual([]);

    // The stronger half: 57 rows fit in one page at the published maximum, so
    // the walk above has to reproduce that sequence exactly — a row handed to
    // two pages or skipped between them shows here and in no single response.
    //
    // It does **not** reach the `id` tie-break, and the boundary is worth
    // stating rather than assumed: measured by mutation, dropping
    // `desc(transactions.id)` from the repository's order reddens nothing in
    // this file, because the seed books no two rows at the same instant.
    // `repositories/transactionRepository.test.ts` plants the ties and owns
    // that claim.
    const whole = await callAsWebB<TransactionList>(
      `${TRANSACTIONS_PATH}?limit=${String(PAGE_LIMIT_MAX)}`,
    );

    expect(whole.body.items).toHaveLength(MOBILE_VIEW_TRANSACTION_COUNT);
    expect(paged.map((transaction) => transaction.id))
      .toEqual(whole.body.items.map((transaction) => transaction.id));
  });

  it('reaches the same 57 rows under a page size the caller chose', async () => {
    // The control for `limit` itself, and it has to assert the page *sizes*:
    // a provider that ignored the parameter and answered every page with all
    // 57 rows still yields 57 distinct identifiers across the walk. Measured —
    // without the sizes below, pinning `limit` to a constant reddens nothing
    // here.
    const size = MOBILE_VIEW.shownTransactionCount * 2;
    const pages = await walk(size);
    const identifiers = new Set(pages.flatMap((page) => page.items).map((row) => row.id));

    expect(pages).toHaveLength(10);
    expect(pages.map((page) => page.items.length)).toEqual([...Array<number>(9).fill(size), 3]);
    expect(pages.every((page) => page.page.limit === size)).toBe(true);
    expect(identifiers.size).toBe(MOBILE_VIEW_TRANSACTION_COUNT);
  });

  it('answers every page with a payload the published document validates', async () => {
    const pages = await walk(PAGE_LIMIT_DEFAULT);
    const checks = pages.map(
      (page) => published.checkResponse('listCompanyTransactions', 200, page),
    );

    expect(checks.flatMap((check) => check.problems)).toEqual([]);
    expect(checks.map((check) => check.ok)).toEqual([true, true, true]);
  });

  it('leaves exactly the dashboard\'s further-item count behind the three it shows', async () => {
    // The two figures the screen shows are one figure: `54 more items` is the
    // list's total minus the three the dashboard lists, and nothing in this
    // service computes them together.
    const dashboard = await callAsWebB<Dashboard>(DASHBOARD_PATH);
    const list = await callAsWebB<TransactionList>(TRANSACTIONS_PATH);

    expect(list.body.page.total - dashboard.body.latestTransactions.length)
      .toBe(dashboard.body.furtherTransactionCount);
    expect(list.body.page.total).toBe(MOBILE_VIEW_TRANSACTION_COUNT);
    expect(dashboard.body.furtherTransactionCount)
      .toBe(MOBILE_VIEW.furtherTransactionCount);
  });
});
