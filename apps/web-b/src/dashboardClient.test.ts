/**
 * The consumer half of spec §2.5, which the provider cannot enforce alone.
 *
 * Both cases stub the response rather than reaching a server, because both are
 * claims about how THIS consumer treats a payload — not about what any
 * particular deployment happens to send today. The point of each is a future
 * provider change: a field added, an enum member added. Neither exists yet, and
 * a test that waited for one would be a test that never ran.
 */

import { describe, expect, it } from 'vitest';

import {
  fetchDashboard,
  toDashboardView,
  toKnownCardState,
  UNKNOWN_CARD_STATE,
} from './dashboardClient';

/** A dashboard payload exactly as `contracts-service-a@0.1.0` publishes it. */
function dashboardPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    company: { id: 'company-1', name: 'Company AB' },
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

/**
 * A stub standing in for `fetch`.
 *
 * The double assertion is deliberate: `typeof fetch` carries a `preconnect`
 * property this stub has no use for, and a single assertion is rejected for
 * exactly that reason. Adding `preconnect` to satisfy the compiler would be
 * inventing behaviour the client never calls.
 */
function stubFetch(body: unknown, status = 200): typeof globalThis.fetch {
  const stub = async (): Promise<Response> => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  return stub as unknown as typeof globalThis.fetch;
}

describe('unknown response fields are ignored', () => {
  it('renders a payload carrying fields this consumer has never heard of', async () => {
    // What contracts-service-a@0.2.0 might look like to a consumer still
    // pinned at 0.1.0: new fields at the root, and nested inside a known one.
    const payload = dashboardPayload({
      loyaltyTier: 'gold',
      company: { id: 'company-1', name: 'Company AB', organisationNumber: '556677-8899' },
      unsettledAuthorisationCount: 3,
    });

    const view = await fetchDashboard('company-1', {
      baseUrl: 'http://service-a.invalid',
      credential: 'demo-web-b-token',
      fetch: stubFetch(payload),
    });

    expect(view.companyName).toBe('Company AB');
    expect(view.furtherTransactionCount).toBe(54);
  });

  it('reads no field it was not built against', () => {
    const view = toDashboardView(dashboardPayload({ loyaltyTier: 'gold' }) as never);

    // The positive control: without this, "no extra key" would also hold for a
    // projection that dropped everything and returned an empty object.
    expect(Object.keys(view).toSorted()).toEqual([
      'cardState',
      'companyName',
      'currency',
      'furtherTransactionCount',
      'latestTransactionCount',
      'limitMinorUnits',
      'remainingMinorUnits',
    ]);
  });
});

describe('an unrecognised enum member is handled, not fatal', () => {
  // Every member CARD_STATES publishes at 0.1.0, read off the contract rather
  // than a remembered subset. `frozen` and `closed` belong here: they ARE
  // published, and an earlier draft of this suite used `frozen` as its
  // unrecognised value and failed against a correct client.
  it.each([
    ['inactive'],
    ['active'],
    ['frozen'],
    ['closed'],
    ['unknown'],
  ])('passes the published member %s through unchanged', (input) => {
    expect(toKnownCardState(input)).toBe(input);
  });

  it('collapses a member added by a later contract version onto unknown', () => {
    // Not in CARD_STATES at 0.1.0. A provider adding it is an additive change
    // that ships without asking this consumer.
    expect(toKnownCardState('repossessed')).toBe(UNKNOWN_CARD_STATE);
  });

  it('renders a dashboard whose card state it does not recognise', async () => {
    const view = await fetchDashboard('company-1', {
      baseUrl: 'http://service-a.invalid',
      credential: 'demo-web-b-token',
      fetch: stubFetch(dashboardPayload({
        card: {
          id: 'card-1',
          lastFour: '4321',
          state: 'repossessed',
          artUrl: 'https://cdn.example.invalid/card-art/business-black-v2.png',
        },
      })),
    });

    expect(view.cardState).toBe(UNKNOWN_CARD_STATE);
    // Still rendered rather than thrown: an added enum member must not take the
    // screen down, which is the whole reason for the unknown member.
    expect(view.companyName).toBe('Company AB');
  });
});

describe('a refusal is surfaced rather than swallowed', () => {
  it('throws naming the status when service-a refuses', async () => {
    await expect(fetchDashboard('company-1', {
      baseUrl: 'http://service-a.invalid',
      credential: 'wrong',
      fetch: stubFetch({ code: 'unauthenticated' }, 401),
    })).rejects.toThrow('401');
  });
});
