/**
 * Everything a route needs that it cannot read off the request.
 *
 * One interface rather than a parameter list per route, because `server.ts`
 * builds it once and hands the same value to all four — and because a route
 * that grows a need states it here, where the one place that has to supply it
 * is looking.
 *
 * Every member is required and nothing has a default, which is the convention
 * `config/env.ts` already sets for this service: a default connection string
 * is how a service talks to whichever database was listening, and a default
 * clock is how a suite that meant to fix time silently depends on when it ran.
 */
import type { CardMappingOptions } from '../mapping/cardMapper';
import type { ServiceDatabase } from '../repositories/database';

/**
 * Where "now" comes from.
 *
 * A function rather than a `Date`, because a router is built once and answers
 * requests for as long as the process lives — a captured instant would stamp
 * every activation with the moment the service started, and would measure
 * every spend window against it.
 */
export type RouteClock = () => Date;

/** What `server.ts` supplies when it builds the router. */
export interface RouteDependencies {
  /** The only handle in this service that reaches Postgres. */
  readonly db: ServiceDatabase;
  /**
   * What the card mapper needs beyond a row: today, where card artwork is
   * served from. Passed through rather than read from the environment here,
   * for the reason `mapping/cardMapper.ts` gives — importing this package must
   * not require a configured machine.
   */
  readonly cardMapping: CardMappingOptions;
  /** The clock an activation is stamped with and a spend window is read at. */
  readonly now: RouteClock;
}
