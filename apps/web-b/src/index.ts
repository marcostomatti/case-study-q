/**
 * Public surface of `@marcos-corp/web-b`, the consumer owned by a different
 * team than `service-a`. This is the cross-team case the governance model
 * exists for.
 *
 * Placeholder: the typed ts-rest client for the dashboard operation
 * (`dashboardClient.ts`), sending a `client_id` distinct from `web-a`'s, lands
 * in a later task and is re-exported here.
 *
 * Three constraints bind whatever is added here, and they are the only reason
 * this package exists at all:
 *
 * - It pins `@marcos-corp/contracts-service-a` at an exact version with no
 *   range specifier (spec 2.2). A gate enforces that.
 * - It sends its own `client_id` derived from its credentials on every request
 *   (spec 2.3), never a `User-Agent`. Distinct from `web-a`'s, so the usage
 *   query can tell the two consumers apart.
 * - It tolerates unknown fields in a response and maps an unrecognised enum
 *   value onto that enum's explicit `unknown` member rather than throwing
 *   (spec 2.5). This package carries the tests for both halves.
 *
 * No framework, and deliberately nothing rendered: the case study does not ask
 * for client-side work, so this consumer proves the governance properties above
 * and stops there. Unlike `@marcos-corp/web-a`, it does not own the contract it
 * consumes, so its contract changes are reviewed through CODEOWNERS.
 */

export {
  CLIENT_ID,
  fetchDashboard,
  toDashboardView,
  toKnownCardState,
  UNKNOWN_CARD_STATE,
} from './dashboardClient';
export type { DashboardClientOptions, DashboardView } from './dashboardClient';
