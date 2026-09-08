/**
 * The ts-rest router: one implementation per operation the contract declares.
 *
 * This is the file `server.ts` hands to `createExpressEndpoints`, and it is
 * deliberately nothing but the mapping. Every route's behaviour lives in
 * `./companyRoutes` or `./cardRoutes`; what lives here is which key each one
 * answers under.
 *
 * ## The mapping is checked, and so is its closure
 *
 * `initServer().router(contract, ...)` requires an entry for **every** route
 * in the contract and refuses any key the contract does not declare, so a
 * fifth operation added to `@marcos-corp/contracts-service-a` fails
 * `bun run check-types` here until it is implemented. That covers the shape of
 * the object; what it cannot cover is whether the implementation registered
 * under `activateCard` is the one that thinks it is `activateCard`, because
 * the id each route passes to `recordOperation` is a string it states itself.
 * `router.test.ts` closes that: it drives every operation to a refusal that
 * needs no database and reads back the `api_usage` row, asserting the recorded
 * operation is the key the route is mounted under.
 *
 * That pairing matters more than it looks. The router keys are exactly the
 * `operationId`s `emitOpenApi` publishes and exactly what spec section 2.3's
 * `api_usage` records, so a route naming itself wrongly does not fail
 * anything — it quietly attributes one operation's traffic to another, and
 * every question the telemetry exists to answer (spec sections 6.2 and 6.4)
 * gets a confident wrong answer.
 *
 * ## Nothing here is mounted
 *
 * No `express.json()`, no middleware, no error handler. A router that mounted
 * its own middleware would make the order of the three things spec section 2.3
 * depends on — identity, then usage logging, then routing — a property of two
 * files instead of one. `server.ts` owns the whole stack, including the
 * handlers `./errors` exports for the paths no route ever sees.
 */
import type { RouteDependencies } from './dependencies';

import { contract } from '@marcos-corp/contracts-service-a';
import { initServer } from '@ts-rest/express';

import { activateCardRoute } from './cardRoutes';
import {
  getCompanyDashboardRoute,
  listCompaniesRoute,
  listCompanyTransactionsRoute,
} from './companyRoutes';

const server = initServer();

/**
 * The implementations, keyed by the operation each one answers.
 *
 * Takes its dependencies once and hands the same set to every route: a router
 * is built at startup and answers requests for the life of the process, so a
 * per-request database handle or a per-request clock would be a decision this
 * layer is not the place to take.
 */
export function buildServiceRouter(deps: RouteDependencies) {
  return server.router(contract, {
    listCompanies: listCompaniesRoute(deps),
    getCompanyDashboard: getCompanyDashboardRoute(deps),
    listCompanyTransactions: listCompanyTransactionsRoute(deps),
    activateCard: activateCardRoute(deps),
  });
}

/** The router `server.ts` mounts, as a type the rest of the service can name. */
export type ServiceRouter = ReturnType<typeof buildServiceRouter>;
