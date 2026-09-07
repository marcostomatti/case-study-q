/**
 * Public surface of `@marcos-corp/web-a`, the consumer owned by the same team
 * as `service-a`.
 *
 * Placeholder: the typed ts-rest client for the dashboard operation
 * (`dashboardClient.ts`) lands in a later task and is re-exported here.
 *
 * Three constraints bind whatever is added here, and they are the only reason
 * this package exists at all:
 *
 * - It pins `@marcos-corp/contracts-service-a` at an exact version with no
 *   range specifier (spec 2.2). A gate enforces that.
 * - It sends a `client_id` derived from its credentials on every request
 *   (spec 2.3), never a `User-Agent`.
 * - It tolerates unknown fields in a response and maps an unrecognised enum
 *   value onto that enum's explicit `unknown` member rather than throwing
 *   (spec 2.5).
 *
 * No framework, and deliberately nothing rendered: the case study does not ask
 * for client-side work, so this consumer proves the governance properties above
 * and stops there. Same team as the provider, so a contract change here needs
 * no cross-team ceremony -- that contrast is what `@marcos-corp/web-b` is for.
 */

export {};
