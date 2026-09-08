/**
 * `web-b`'s client for `service-a` — the cross-team consumer, and the one the
 * governance case is actually about.
 *
 * `web-a` consumes the same provider from inside the provider's own team, so
 * its adoption needs no ceremony. `web-b` is a different team: it authors
 * contract proposals against a package it does not own, waits for CODEOWNERS
 * approval, and pins the resulting version exactly. Everything in this file is
 * a consequence of that.
 *
 * Types come from `@marcos-corp/contracts-service-a` rather than from a
 * generator (spec §5). There is no generation step to drift, and the pinned
 * version in this package's manifest is the single fact that says which
 * contract this consumer is built against.
 *
 * The two spec §2.5 consumer obligations both live here, and both are the
 * consumer's half of a bargain the provider cannot keep alone:
 *
 * - Unknown response fields are IGNORED. A provider adding a field is additive
 *   and ships without asking; a consumer that rejects unknown fields turns
 *   every such addition into an outage.
 * - An unrecognised enum member is mapped to `unknown` and handled. Adding an
 *   enum value is otherwise a silent break — the field still parses, the value
 *   is simply one nothing knows what to do with.
 */

import {
  CARD_STATES,
  type CardState,
  type Dashboard,
} from '@marcos-corp/contracts-service-a';

/** The `client_id` `service-a` issued to this consumer. See spec §6.3. */
export const CLIENT_ID = 'web-b';

/** The enum member every unrecognised card state collapses onto. */
export const UNKNOWN_CARD_STATE: CardState = 'unknown';

export interface DashboardClientOptions {
  /** Where `service-a` answers — the real service, or the Prism mock. */
  readonly baseUrl: string;
  /** The credential issued alongside this consumer's `client_id`. */
  readonly credential: string;
  /** Defaults to the global `fetch`; a suite passes a stub. */
  readonly fetch?: typeof globalThis.fetch;
}

/** What this consumer renders, after tolerating whatever else arrived. */
export interface DashboardView {
  readonly companyName: string;
  readonly cardState: CardState;
  readonly remainingMinorUnits: number;
  readonly limitMinorUnits: number;
  readonly currency: string;
  readonly latestTransactionCount: number;
  readonly furtherTransactionCount: number;
}

/**
 * Narrows an arbitrary string onto the published enum, collapsing anything
 * unrecognised onto `unknown`.
 *
 * The membership test reads `CARD_STATES` from the contract package rather than
 * restating the members here. A local copy is a second source of truth that
 * goes stale the first time the provider adds a member, which is precisely the
 * case this function exists to survive.
 */
export function toKnownCardState(value: string): CardState {
  return (CARD_STATES as readonly string[]).includes(value)
    ? (value as CardState)
    : UNKNOWN_CARD_STATE;
}

/**
 * Projects the response onto what this consumer renders.
 *
 * Reading named fields is what "ignore unknown fields" means in practice —
 * there is no schema rejection step, so a field this consumer has never heard
 * of is simply never read.
 */
export function toDashboardView(payload: Dashboard): DashboardView {
  return {
    companyName: payload.company.name,
    cardState: toKnownCardState(payload.card.state),
    remainingMinorUnits: payload.spend.remaining.minorUnits,
    limitMinorUnits: payload.spend.limit.minorUnits,
    currency: payload.spend.remaining.currency,
    latestTransactionCount: payload.latestTransactions.length,
    furtherTransactionCount: payload.furtherTransactionCount,
  };
}

/** Fetches one company's dashboard and projects it onto the rendered view. */
export async function fetchDashboard(
  companyId: string,
  options: DashboardClientOptions,
): Promise<DashboardView> {
  const doFetch = options.fetch ?? globalThis.fetch;

  const response = await doFetch(`${options.baseUrl}/companies/${companyId}/dashboard`, {
    headers: { Authorization: `Bearer ${options.credential}` },
  });

  if (!response.ok) {
    throw new Error(`service-a answered ${response.status} for company ${companyId}`);
  }

  return toDashboardView(await response.json() as Dashboard);
}
