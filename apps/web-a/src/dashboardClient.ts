/**
 * `web-a`'s client for `service-a` — the same-team consumer.
 *
 * Deliberately thin, and the thinness is the point. `web-a` and `service-a`
 * are owned by the same team, so a contract change here needs no cross-team
 * negotiation: the same people author it and approve it, and CODEOWNERS routes
 * the review to the team that was going to do it anyway. Spec §1 asks for this
 * case precisely to show that the governance machinery adds no ceremony where
 * none is needed.
 *
 * What does NOT differ from `web-b`:
 *
 * - The pin is exact (spec §2.2). Same-team is not a reason to float a range;
 *   the manifest is still the record of which version this consumer builds
 *   against, and CI's pin gate does not know or care whose team it is.
 * - Types come from the contract package, not a generator (spec §5).
 * - Its `client_id` is its own, so `api_usage` can tell it apart from `web-b`.
 *
 * The cross-team obligations of spec §2.5 — tolerating unknown fields, folding
 * unrecognised enum members — are exercised in `apps/web-b`, which is the
 * consumer that actually has to survive a provider it does not control.
 */

import type { CompanySummary } from '@marcos-corp/contracts-service-a';

/** The `client_id` `service-a` issued to this consumer. See spec §6.3. */
export const CLIENT_ID = 'web-a';

export interface CompanySelectorOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly fetch?: typeof globalThis.fetch;
}

/** One page of the companies the selector at the top of the screen lists. */
interface CompanyListResponse {
  readonly items: readonly CompanySummary[];
}

/** Lists the companies this caller may act for, for the company selector. */
export async function fetchCompanies(
  options: CompanySelectorOptions,
): Promise<readonly CompanySummary[]> {
  const doFetch = options.fetch ?? globalThis.fetch;

  const response = await doFetch(`${options.baseUrl}/companies`, {
    headers: { Authorization: `Bearer ${options.credential}` },
  });

  if (!response.ok) {
    throw new Error(`service-a answered ${response.status} listing companies`);
  }

  return (await response.json() as CompanyListResponse).items;
}
