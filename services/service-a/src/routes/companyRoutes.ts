/**
 * The three company-scoped reads: the selector's list, the dashboard the
 * mobile view renders, and the transaction view behind `54 more items`.
 *
 * Each is built with `initServer().route(contract.<key>, ...)`, which is what
 * makes the handler's `params`, `query` and return value inferred from the
 * contract rather than annotated here. A route answering a status the contract
 * does not declare, or an error body that is not the shared shape, is a
 * `bun run check-types` failure — measured, with a controls run on an
 * undeclared `418` and a code outside the published catalogue.
 *
 * ## The shape every route in this service has
 *
 * 1. **Name the operation first.** `recordOperation` runs before anything can
 *    fail, so a request refused at validation still writes an `api_usage` row
 *    naming the operation it was refused by (spec section 2.3). A route that
 *    named itself after validating would leave every `400` recorded as
 *    `<unrouted>`, which is the one shape the telemetry cannot answer a
 *    "who calls this" question from.
 * 2. **Check the request against the contract**, through `./requestParsing` —
 *    ts-rest validates nothing here, because these schemas are TypeBox rather
 *    than zod. That module's header has the measurement.
 * 3. **Refuse an identifier this provider could not have issued** before
 *    spending a round trip on it.
 * 4. **Read, map, answer.** Rows never reach a response: `mapping/` translates
 *    them, which is what keeps a column rename out of the contract.
 *
 * The success status is written as a literal `200` because `tsc` checks it
 * against the operation's declared responses; the failure statuses are named
 * in `./errors` because *which* failure is the part worth reading.
 *
 * ## Two reads at once, and who pays for it
 *
 * The dashboard needs a company and its card, and the transaction view needs
 * a company and a page of its rows. Both pairs are needed on every request
 * that is not a mistake, so both are issued together rather than in sequence.
 * A `404` then pays for one read it did not need; every `200` — the phone
 * opening the screen — saves a round trip. The reads that genuinely depend on
 * an earlier answer, the spend limit and the transactions measured against its
 * window, stay sequential because they cannot be anything else.
 *
 * ## What `listCompanies` does not yet do
 *
 * The contract says "every company the caller may act for", and this returns
 * every company there is. Nothing in the data model maps a `client_id` to a
 * set of companies yet — `ClientIdentity` carries an id and an owner, and
 * `packages/db` has no consumer-to-company table — so there is no scope to
 * apply. Recorded here rather than implied by silence: the shape of the fix is
 * a registration-time company list on `RegisteredConsumer`, filtered in this
 * route and in the three below, and it is a change no consumer can see.
 */
import type { RouteDependencies } from './dependencies';
import type { PageRequest } from '../repositories/pagination';
import type { PaginationQuery } from '@marcos-corp/contracts-service-a';

import {
  contract,
  DASHBOARD_TRANSACTION_COUNT,
} from '@marcos-corp/contracts-service-a';
import { initServer } from '@ts-rest/express';

import { toCompanySummary, toDashboard } from '../mapping/dashboardMapper';
import { toContractTransaction } from '../mapping/transactionMapper';
import { findCompanyCard } from '../repositories/cardRepository';
import {
  findCompanyById,
  listCompanies as listCompanyRows,
} from '../repositories/companyRepository';
import {
  DASHBOARD_RESET_PERIOD,
  findCurrentSpendLimit,
} from '../repositories/spendLimitRepository';
import {
  countCompanyTransactions,
  findDashboardTransactions,
  listCompanyTransactions as listCompanyTransactionRows,
} from '../repositories/transactionRepository';
import { recordOperation } from '../telemetry/usageLogger';

import {
  NOT_FOUND_STATUS,
  notFound,
  VALIDATION_FAILED_STATUS,
} from './errors';
import {
  isIssuedIdentifier,
  parseQueryParameters,
  parseRequestPayload,
} from './requestParsing';

const server = initServer();

/**
 * The page the contract's own defaults resolved to.
 *
 * Both `PaginationQuery` members declare a `default`, and
 * `parseQueryParameters` applies every default the document states — so by the
 * time a checked query reaches here both fields are present, and the published
 * `limit: 20` / `offset: 0` are the numbers this provider applies without
 * restating either.
 *
 * The optional type cannot say that, so the absent case throws rather than
 * falling back. A fallback would be a second copy of a published figure that
 * silently took over the moment the contract stopped declaring one — the same
 * argument `readTotal` makes for refusing to answer "there are no rows" when
 * the query did something it does not understand.
 */
function requirePage(query: PaginationQuery): PageRequest {
  const { limit, offset } = query;
  if (limit === undefined || offset === undefined) {
    throw new Error(
      'the contract\'s pagination defaults did not reach this request, so PaginationQuery '
      + 'has stopped declaring a `default` for limit or offset and this provider no longer '
      + 'applies the page size its own document publishes',
    );
  }

  return { limit, offset };
}

/**
 * The companies the selector at the top of the mobile view lists.
 *
 * Paginated even though the demo renders one or two rows: a list with no
 * ceiling in the contract is an unbounded query in the provider, and the
 * ceiling is the contract's rather than this route's.
 */
export function listCompaniesRoute(deps: RouteDependencies) {
  return server.route(contract.listCompanies, async ({ query, req }) => {
    recordOperation(req, 'listCompanies');

    const parsed = parseQueryParameters(contract.listCompanies.query, query);
    if (!parsed.ok) {
      return { status: VALIDATION_FAILED_STATUS, body: parsed.error };
    }

    const { limit, offset } = requirePage(parsed.value);
    const page = await listCompanyRows(deps.db, { limit, offset });

    return {
      status: 200,
      body: {
        items: page.items.map(toCompanySummary),
        page: { limit, offset, total: page.total },
      },
    };
  });
}

/**
 * Everything the mobile view renders for one company, in one response.
 *
 * The four `404`s below are one answer to four questions, and that is
 * deliberate: a company that does not exist, a company that is not this
 * caller's, a company with no card and a card with no configured limit all
 * mean the same thing to the screen — there is no dashboard at this address.
 * The contract publishes a `Dashboard` with a required card and a required
 * spend figure, so there is no payload that could express "a company, but not
 * yet a card", and inventing one here would be publishing a shape the document
 * does not describe.
 */
export function getCompanyDashboardRoute(deps: RouteDependencies) {
  return server.route(contract.getCompanyDashboard, async ({ params, req }) => {
    recordOperation(req, 'getCompanyDashboard');

    const parsed = parseRequestPayload(contract.getCompanyDashboard.pathParams, params);
    if (!parsed.ok) {
      return { status: VALIDATION_FAILED_STATUS, body: parsed.error };
    }

    const { companyId } = parsed.value;
    if (!isIssuedIdentifier(companyId)) {
      return { status: NOT_FOUND_STATUS, body: notFound(missingCompany(companyId)) };
    }

    const [company, card] = await Promise.all([
      findCompanyById(deps.db, companyId),
      findCompanyCard(deps.db, companyId),
    ]);

    if (company === null) {
      return { status: NOT_FOUND_STATUS, body: notFound(missingCompany(companyId)) };
    }

    if (card === null) {
      return {
        status: NOT_FOUND_STATUS,
        body: notFound(`company '${companyId}' holds no card, so it has no dashboard`),
      };
    }

    const spendLimit = await findCurrentSpendLimit(deps.db, {
      cardId: card.id,
      resetPeriod: DASHBOARD_RESET_PERIOD,
      asOf: deps.now(),
    });

    if (spendLimit === null) {
      return {
        status: NOT_FOUND_STATUS,
        body: notFound(
          `company '${companyId}' has no ${DASHBOARD_RESET_PERIOD} spend limit in force, `
          + 'so its dashboard has no meter to render',
        ),
      };
    }

    const [transactions, transactionCount] = await Promise.all([
      findDashboardTransactions(deps.db, {
        companyId,
        cardId: card.id,
        bookedSince: spendLimit.periodStartedAt,
        listCount: DASHBOARD_TRANSACTION_COUNT,
      }),
      countCompanyTransactions(deps.db, companyId),
    ]);

    return {
      status: 200,
      body: toDashboard(
        { company, card, spendLimit, transactions, transactionCount },
        deps.cardMapping,
      ),
    };
  });
}

/**
 * The paginated transaction view the dashboard's `N more items` link opens.
 *
 * The company is looked up rather than assumed, so an unknown identifier is a
 * `404` instead of an empty page. An empty page is a real answer — a company
 * whose card has never been used has one — and a route that let both mean the
 * same thing would tell a consumer nothing it could act on.
 */
export function listCompanyTransactionsRoute(deps: RouteDependencies) {
  return server.route(contract.listCompanyTransactions, async ({ params, query, req }) => {
    recordOperation(req, 'listCompanyTransactions');

    const parsedParams = parseRequestPayload(
      contract.listCompanyTransactions.pathParams,
      params,
    );
    if (!parsedParams.ok) {
      return { status: VALIDATION_FAILED_STATUS, body: parsedParams.error };
    }

    const parsedQuery = parseQueryParameters(contract.listCompanyTransactions.query, query);
    if (!parsedQuery.ok) {
      return { status: VALIDATION_FAILED_STATUS, body: parsedQuery.error };
    }

    const { companyId } = parsedParams.value;
    if (!isIssuedIdentifier(companyId)) {
      return { status: NOT_FOUND_STATUS, body: notFound(missingCompany(companyId)) };
    }

    const { limit, offset } = requirePage(parsedQuery.value);
    const [company, page] = await Promise.all([
      findCompanyById(deps.db, companyId),
      listCompanyTransactionRows(deps.db, { companyId }, { limit, offset }),
    ]);

    if (company === null) {
      return { status: NOT_FOUND_STATUS, body: notFound(missingCompany(companyId)) };
    }

    return {
      status: 200,
      body: {
        items: page.items.map(toContractTransaction),
        page: { limit, offset, total: page.total },
      },
    };
  });
}

/**
 * The one sentence three routes answer with.
 *
 * Written once because it is one decision, not three: the catalogue folds
 * "there is no such company" and "that company is not yours" onto `not_found`,
 * so the wording must not distinguish them either. Echoing the identifier is
 * safe — the caller sent it, and it is bounded by `CompanyId`'s `maxLength`,
 * which the parse above has already enforced.
 */
function missingCompany(companyId: string): string {
  return `service-a holds no company '${companyId}' for this caller`;
}
