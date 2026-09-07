import type { TSchema } from '@sinclair/typebox';

import { describe, expect, it } from 'vitest';

import { Card } from './card';
import { CompanySummary } from './company';
import { DASHBOARD_TRANSACTION_COUNT, Dashboard, SpendSummary } from './dashboard';
import { MonetaryAmount } from './shared';
import { Transaction } from './transaction';

/**
 * What this file pins that `dashboard.test-d.ts` cannot: which shapes reach the
 * emitted document as shared components and which are inlined, and the bounds
 * on the two figures the meter and the `54 more items` link render. None of
 * that appears in a `Static<>` type.
 *
 * See `shared.test.ts` for why every assertion is over the JSON round trip.
 */
const emitted = (schema: TSchema): Record<string, unknown> => JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;

const properties = (schema: TSchema): Record<string, Record<string, unknown>> => (
  emitted(schema)['properties'] as Record<string, Record<string, unknown>>
);

describe('the remaining-spend summary', () => {
  it('publishes the two figures the meter renders, and nothing else', () => {
    expect(emitted(SpendSummary)).toEqual({
      description:
        'What is left to spend in the current period, and the limit it is measured against.',
      additionalProperties: true,
      type: 'object',
      required: ['remaining', 'limit'],
      properties: {
        remaining: emitted(MonetaryAmount),
        limit: emitted(MonetaryAmount),
      },
    });
  });

  it('publishes two amounts rather than a rendered `5 400/10 000 kr`', () => {
    // A preformatted string would move the provider's locale into every client
    // and make the numbers unusable for anything but display — the mistake
    // `MonetaryAmount` exists to prevent. A percentage would throw away the
    // figures the screen actually prints.
    expect(properties(SpendSummary)['remaining']?.['type']).toBe('object');
    expect(properties(SpendSummary)['limit']?.['type']).toBe('object');
  });

  it('reuses the shared money component for both figures', () => {
    // The `$id` surviving in place is what says these are the shared shape
    // rather than two structurally similar copies that can drift. What the
    // shape itself states is `shared.test.ts`'s claim, not this file's.
    expect(properties(SpendSummary)['remaining']?.['$id']).toBe('MonetaryAmount');
    expect(properties(SpendSummary)['limit']?.['$id']).toBe('MonetaryAmount');
  });

  it('leaves the remaining figure signed, so an overrun is visible', () => {
    // A card whose settled spend has overrun its cap reports a negative
    // remaining figure rather than a clamped zero that hides it.
    const remaining = properties(SpendSummary)['remaining'] as Record<string, Record<string, unknown>>;
    const minorUnits = (remaining['properties'] as Record<string, Record<string, unknown>>)['minorUnits'];

    expect(minorUnits).not.toHaveProperty('minimum');
  });

  it('is inlined rather than hoisted, being named by nothing else', () => {
    // The convention this package follows hoists a shape more than one
    // operation names. A component here would put the meter's two figures one
    // indirection away from the field that carries them, for no reuse.
    expect(emitted(SpendSummary)).not.toHaveProperty('$id');
  });
});

describe('the dashboard', () => {
  it('publishes the whole screen: company, card, meter, list and remainder', () => {
    expect(emitted(Dashboard)).toEqual({
      $id: 'Dashboard',
      description: 'Everything the mobile view renders, in one response.',
      additionalProperties: true,
      type: 'object',
      required: [
        'company',
        'card',
        'spend',
        'latestTransactions',
        'furtherTransactionCount',
      ],
      properties: {
        company: emitted(CompanySummary),
        card: emitted(Card),
        spend: emitted(SpendSummary),
        latestTransactions: {
          description: 'The newest transactions, newest first.',
          maxItems: DASHBOARD_TRANSACTION_COUNT,
          type: 'array',
          items: emitted(Transaction),
        },
        furtherTransactionCount: {
          description: 'Transactions beyond the ones listed here, for the `N more items` link.',
          minimum: 0,
          examples: [54],
          type: 'integer',
        },
      },
    });
  });

  it('embeds the shapes other operations share, by reference', () => {
    // A field added to `Card` then shows up once in the diff gate's report,
    // against `Card`, rather than once per operation that embeds it.
    expect(properties(Dashboard)['company']?.['$id']).toBe('CompanySummary');
    expect(properties(Dashboard)['card']?.['$id']).toBe('Card');

    const list = properties(Dashboard)['latestTransactions'] as Record<string, Record<string, unknown>>;

    expect(list['items']?.['$id']).toBe('Transaction');
  });

  it('caps the list at the three rows the screen draws', () => {
    // Stated in the document so a consumer sizes its layout from the contract
    // rather than from a response it happened to receive.
    expect(properties(Dashboard)['latestTransactions']?.['maxItems']).toBe(3);
    expect(DASHBOARD_TRANSACTION_COUNT).toBe(3);
  });

  it('admits an empty list, for a card that has never been used', () => {
    // A `minItems` here would make the first day of a new account an error.
    expect(properties(Dashboard)['latestTransactions']).not.toHaveProperty('minItems');
  });

  it('publishes the count of further rows rather than a total', () => {
    // `54 more items in transaction view` is what the screen renders.
    // Publishing a total as well would be two derived figures a consumer could
    // find in disagreement; the total lives on the paginated list, in
    // `PageInfo.total`, where it is actually useful.
    expect(properties(Dashboard)['furtherTransactionCount']?.['examples']).toEqual([54]);
    expect(Object.keys(properties(Dashboard))).not.toContain('transactionCount');
    expect(Object.keys(properties(Dashboard))).not.toContain('totalTransactionCount');
  });

  it('counts from zero, for a company with nothing beyond the three shown', () => {
    expect(properties(Dashboard)['furtherTransactionCount']?.['type']).toBe('integer');
    expect(properties(Dashboard)['furtherTransactionCount']?.['minimum']).toBe(0);
  });

  it('carries no invoice, which service-b owns', () => {
    // The `Invoice due >` banner is a second call. Having `service-a` fan out
    // for it would put one team's contract behind another team's availability
    // and make every `service-b` outage a `service-a` outage.
    expect(Object.keys(properties(Dashboard))).toEqual([
      'company',
      'card',
      'spend',
      'latestTransactions',
      'furtherTransactionCount',
    ]);
  });

  it('makes every member required, so the screen renders in one pass', () => {
    // An optional member would mean a consumer branching on absence for a field
    // the view always draws.
    expect(emitted(Dashboard)['required']).toEqual(Object.keys(properties(Dashboard)));
  });

  it('is hoisted into components under a stable name', () => {
    // One operation returns it, but the name is what a consumer's generated
    // client binds to and what the diff gate reports a change against.
    expect(emitted(Dashboard)['$id']).toBe('Dashboard');
  });

  it('tolerates unknown fields, like every response in this contract', () => {
    // Spec §2.5: the provider deploys before the consumer adopts, so a consumer
    // pinned to an older version routinely sees fields that version predates.
    expect(emitted(Dashboard)['additionalProperties']).toBe(true);
  });
});
