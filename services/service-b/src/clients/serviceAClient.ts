/**
 * `service-b`'s client for `service-a`. The blocked task, and the reason
 * `service-b` is in the spec at all.
 *
 * `service-b` is a provider: it owns `contracts-service-b` and answers the
 * due-invoice operation. It is also a consumer, and spec §1 requires that
 * combination so the design has to show that **ownership shifts** — today's
 * provider is tomorrow's consumer, and nothing about the mechanism changes
 * when it does.
 *
 * Concretely, every obligation `apps/web-b` carries applies here unaltered:
 *
 * - `@marcos-corp/contracts-service-a` is pinned exactly, no range (§2.2), and
 *   bumping it is a reviewed PR on a CODEOWNERS path — demonstrated by
 *   `scripts/acceptance/05-pin-bump-is-reviewable.ts`.
 * - It presents its own credential so `service-a` resolves `client_id`
 *   `service-b`, distinct from either app in `api_usage` (§2.3).
 * - It tolerates unknown response fields (§2.5). A provider consuming another
 *   provider has no more right to reject an additive change than an app does.
 *
 * Types come from the contract package rather than a generator (§5), so this
 * client and `service-a`'s router are provably the same API rather than two
 * descriptions of one.
 */

import type { CompanySummary, Dashboard } from '@marcos-corp/contracts-service-a';

/** The `client_id` `service-a` issued to this consumer. */
export const CLIENT_ID = 'service-b';

/** How long to wait on `service-a` before answering without it. */
const DEFAULT_TIMEOUT_MS = 5_000;

export interface ServiceAClientOptions {
  /** Where `service-a` answers — the real service, or the Prism mock. */
  readonly baseUrl: string;
  /** The credential issued alongside this consumer's `client_id`. */
  readonly credential: string;
  /** Defaults to the global `fetch`; a suite passes a stub. */
  readonly fetch?: typeof globalThis.fetch;
  /** Defaults to `DEFAULT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** What `service-b` needs from `service-a` to give an invoice its context. */
export interface CompanyContext {
  readonly company: CompanySummary;
  readonly currency: string;
}

/** Raised when `service-a` could not answer. Never swallowed into a default. */
export class ServiceAUnavailableError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ServiceAUnavailableError';
  }
}

export interface ServiceAClient {
  companyContext: (companyId: string) => Promise<CompanyContext>;
}

/**
 * Builds the typed client.
 *
 * A factory rather than a module-level singleton for the same reason every
 * other module in this repo takes what it needs: importing this file must not
 * require a configured environment or a reachable `service-a`.
 */
export function createServiceAClient(options: ServiceAClientOptions): ServiceAClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async companyContext(companyId: string): Promise<CompanyContext> {
      let response: Response;

      try {
        response = await doFetch(`${options.baseUrl}/companies/${companyId}/dashboard`, {
          headers: { Authorization: `Bearer ${options.credential}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new ServiceAUnavailableError(
          `service-a did not answer for company ${companyId}: `
          + `${error instanceof Error
            ? error.message
            : String(error)}`,
        );
      }

      if (!response.ok) {
        throw new ServiceAUnavailableError(
          `service-a answered ${response.status} for company ${companyId}`,
          response.status,
        );
      }

      // Reading named fields IS the tolerance: there is no rejection step, so a
      // field this consumer has never heard of is simply never read. Parsing the
      // response against a local schema would reintroduce exactly the coupling
      // spec §2.5 removes.
      const dashboard = await response.json() as Dashboard;

      return {
        company: dashboard.company,
        currency: dashboard.spend.limit.currency,
      };
    },
  };
}
