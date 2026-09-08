/**
 * `service-b` consuming `service-a`, which is the same bargain `apps/web-b`
 * keeps — a provider gets no exemption from it.
 *
 * Every case asserts what the STUB RECEIVED, not only what the client returned.
 * A stub-backed client test passes against a client that never called it: if a
 * base-URL override were missed and the real service were unreachable, a test
 * checking only the return value would fail for the right reason today and the
 * wrong reason tomorrow. Asserting the request pins that the call happened, to
 * the right URL, carrying the right credential.
 */

import { describe, expect, it } from 'vitest';

import {
  createServiceAClient,
  ServiceAUnavailableError,
} from './serviceAClient';

const COMPANY_ID = 'company-1';
const BASE_URL = 'http://service-a.invalid';
const CREDENTIAL = 'demo-service-b-token';

function dashboardPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    company: { id: COMPANY_ID, name: 'Company AB' },
    card: {
      id: 'card-1',
      lastFour: '4321',
      state: 'active',
      artUrl: 'https://cdn.example.invalid/card-art/business-black-v2.png',
    },
    spend: {
      remaining: { minorUnits: 540_000, currency: 'SEK' },
      limit: { minorUnits: 1_000_000, currency: 'SEK' },
    },
    latestTransactions: [],
    furtherTransactionCount: 54,
    ...overrides,
  };
}

/** A stub that records every request it was handed. */
function recordingFetch(body: unknown, status = 200): {
  fetch: typeof globalThis.fetch;
  calls: { url: string; authorization: string | null }[];
} {
  const calls: { url: string; authorization: string | null }[] = [];

  // Neither `RequestInit` nor `HeadersInit` is a name in this repo: there is no
  // DOM lib and no eslint global for either, so both resolve to nothing and
  // `no-undef` fires. Taking the parameter as `unknown` and narrowing is what
  // survives both gates; the one field these cases read is the header.
  const stub = async (input: unknown, init?: unknown): Promise<Response> => {
    const headers = new Headers(
      (init as { headers?: Record<string, string> } | undefined)?.headers ?? {},
    );
    calls.push({ url: String(input), authorization: headers.get('authorization') });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { fetch: stub as unknown as typeof globalThis.fetch, calls };
}

describe('the request service-b actually sends', () => {
  it('calls the pinned contract path carrying its own credential', async () => {
    const { fetch, calls } = recordingFetch(dashboardPayload());

    await createServiceAClient({ baseUrl: BASE_URL, credential: CREDENTIAL, fetch })
      .companyContext(COMPANY_ID);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE_URL}/companies/${COMPANY_ID}/dashboard`);
    // spec §2.3: the provider resolves client_id from this, so a request
    // without it is indistinguishable from an unregistered caller.
    expect(calls[0]?.authorization).toBe(`Bearer ${CREDENTIAL}`);
  });
});

describe('unknown response fields are tolerated', () => {
  it('reads a payload carrying fields added by a later contract version', async () => {
    const { fetch } = recordingFetch(dashboardPayload({
      loyaltyTier: 'gold',
      company: { id: COMPANY_ID, name: 'Company AB', organisationNumber: '556677-8899' },
    }));

    const context = await createServiceAClient({ baseUrl: BASE_URL, credential: CREDENTIAL, fetch })
      .companyContext(COMPANY_ID);

    expect(context.company.name).toBe('Company AB');
    expect(context.currency).toBe('SEK');
  });
});

describe('a failure is surfaced, never defaulted away', () => {
  it('throws naming the status when service-a refuses', async () => {
    const { fetch } = recordingFetch({ code: 'unauthenticated' }, 401);

    await expect(
      createServiceAClient({ baseUrl: BASE_URL, credential: 'wrong', fetch })
        .companyContext(COMPANY_ID),
    ).rejects.toThrow(ServiceAUnavailableError);
  });

  it('throws when service-a cannot be reached at all', async () => {
    const refusing = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    await expect(
      createServiceAClient({ baseUrl: BASE_URL, credential: CREDENTIAL, fetch: refusing })
        .companyContext(COMPANY_ID),
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('carries the status through so a caller can tell refusal from outage', async () => {
    const { fetch } = recordingFetch({}, 503);

    // A client that collapsed every failure into one shape would pass the two
    // cases above while making 401 and 503 indistinguishable to its caller.
    await expect(
      createServiceAClient({ baseUrl: BASE_URL, credential: CREDENTIAL, fetch })
        .companyContext(COMPANY_ID),
    ).rejects.toMatchObject({ status: 503 });
  });
});
