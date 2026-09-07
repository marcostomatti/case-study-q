import type { TSchema } from '@sinclair/typebox';

import { describe, expect, it } from 'vitest';

import { MonetaryAmount } from './shared';
import {
  MERCHANT_CATEGORIES,
  MerchantCategory,
  TRANSACTION_SETTLEMENT_STATES,
  Transaction,
  TransactionId,
  TransactionSettlementState,
} from './transaction';

/**
 * What this file pins that `transaction.test-d.ts` cannot: the JSON these two
 * enums publish, and in particular the `enum` keyword house rule 3 selects on.
 * A `Static<>` type is the same union whether the schema emits `enum` or the
 * `anyOf` of `const`s that would leave spec §2.5 unenforced here.
 *
 * See `shared.test.ts` for why every assertion is over the JSON round trip.
 */
const emitted = (schema: TSchema): Record<string, unknown> => JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;

const properties = (schema: TSchema): Record<string, Record<string, unknown>> => (
  emitted(schema)['properties'] as Record<string, Record<string, unknown>>
);

/** The states `transactions.settlement_state` declares, spelled out rather than imported. */
const DATABASE_SETTLEMENT_STATES = ['authorised', 'settled', 'reversed', 'disputed'];

/** ISO-18245 codes the seed books against, as `merchant_category_code` stores them. */
const DATABASE_MERCHANT_CATEGORY_CODES = ['7011', '5541', '5499', '4111', '5200', '5814', '7372', '4814', '4112'];

describe('the settlement state enum', () => {
  it('publishes a JSON Schema enum, not an anyOf of consts', () => {
    // `Type.Union([Type.Literal(...)])` — the idiomatic TypeBox spelling —
    // emits `anyOf`, which house rule 3's `given: $..[?(@.enum)]` never
    // selects. The rule would load, report nothing, and count toward coverage
    // while spec §2.5 stopped being enforced.
    expect(emitted(TransactionSettlementState)).toEqual({
      type: 'string',
      enum: ['pending', 'completed', 'reversed', 'unknown'],
      description: 'How far the transaction has got. Unrecognised values are `unknown`.',
    });
  });

  it('carries the unknown member spec §2.5 requires', () => {
    expect(emitted(TransactionSettlementState)['enum']).toContain('unknown');
  });

  it('is coarser than the database settlement cycle it maps from', () => {
    // `authorised` and `disputed` both fold onto `pending`: a consumer branches
    // on whether the amount is final, and neither is. This case is what fails
    // if someone "aligns" the two vocabularies, which would make every
    // provider-side clearing change a breaking contract change.
    const real = TRANSACTION_SETTLEMENT_STATES.filter((state) => state !== 'unknown');

    expect(real.length).toBeLessThan(DATABASE_SETTLEMENT_STATES.length);
  });

  it('keeps the clearing vocabulary out of the contract', () => {
    // `authorised` is the issuer's word and `settled` is the acquirer's;
    // neither is the cardholder's. `reversed` coincides because the word means
    // the same thing on both sides — a coincidence, not a derivation, the same
    // way `active` and `frozen` coincide in `CARD_STATES`.
    expect(TRANSACTION_SETTLEMENT_STATES as readonly string[]).not.toContain('authorised');
    expect(TRANSACTION_SETTLEMENT_STATES as readonly string[]).not.toContain('settled');
    expect(TRANSACTION_SETTLEMENT_STATES as readonly string[]).not.toContain('disputed');
  });

  it('names the one state the remaining-spend meter counts', () => {
    // `services/service-a`'s dashboard mapper subtracts exactly these from the
    // cap, so this member is depended on by name from another package.
    expect(TRANSACTION_SETTLEMENT_STATES as readonly string[]).toContain('completed');
  });

  it('keeps the vocabulary unique and machine-readable', () => {
    // A duplicate is invisible in a list and reaches the emitted document as
    // one. A member with a space or a capital is not something a consumer
    // switches on comfortably.
    expect([...new Set(TRANSACTION_SETTLEMENT_STATES)]).toEqual([...TRANSACTION_SETTLEMENT_STATES]);
    expect(TRANSACTION_SETTLEMENT_STATES.filter((state) => !/^[a-z][a-z0-9_]*$/.test(state))).toEqual([]);
  });
});

describe('the merchant category enum', () => {
  it('publishes a JSON Schema enum, not an anyOf of consts', () => {
    expect(emitted(MerchantCategory)).toEqual({
      type: 'string',
      enum: [
        'dining',
        'fuel',
        'groceries',
        'retail',
        'software',
        'telecom',
        'travel',
        'unknown',
      ],
      description:
        'Coarse merchant category, folded from an ISO-18245 MCC. Unrecognised values are `unknown`.',
    });
  });

  it('carries the unknown member spec §2.5 requires', () => {
    // The one enum in this contract whose source is an open set nobody here
    // controls: the card networks add MCCs without asking. Without this member
    // a new code in the acquirer feed is a break for every pinned consumer.
    expect(emitted(MerchantCategory)['enum']).toContain('unknown');
  });

  it('publishes categories rather than the ISO-18245 codes behind them', () => {
    // A consumer switching on `5814` would be switching on a standard neither
    // party controls. The codes stay in `transactions.merchant_category_code`
    // and the mapper folds them.
    for (const code of DATABASE_MERCHANT_CATEGORY_CODES) {
      expect(MERCHANT_CATEGORIES as readonly string[]).not.toContain(code);
    }

    expect(MERCHANT_CATEGORIES.filter((category) => /[0-9]/.test(category))).toEqual([]);
  });

  it('is far coarser than the set it folds from', () => {
    // Nine distinct codes appear in the seed alone and the real set runs to
    // hundreds; this enum has seven members plus `unknown`.
    const real = MERCHANT_CATEGORIES.filter((category) => category !== 'unknown');

    expect(real.length).toBeLessThan(DATABASE_MERCHANT_CATEGORY_CODES.length);
  });

  it('stays alphabetical with unknown last', () => {
    // Ordering buys exactly one thing here: the position a new member is
    // inserted at is obvious in a diff. A member appended out of order makes
    // that unreadable.
    const real = MERCHANT_CATEGORIES.filter((category) => category !== 'unknown');

    expect([...real].sort()).toEqual(real);
    expect(MERCHANT_CATEGORIES.at(-1)).toBe('unknown');
  });

  it('keeps the vocabulary unique and machine-readable', () => {
    expect([...new Set(MERCHANT_CATEGORIES)]).toEqual([...MERCHANT_CATEGORIES]);
    expect(MERCHANT_CATEGORIES.filter((category) => !/^[a-z][a-z0-9_]*$/.test(category))).toEqual([]);
  });
});

describe('the transaction identifier', () => {
  it('publishes as an opaque bounded string, like the other identifiers here', () => {
    expect(emitted(TransactionId)).toEqual({
      description: 'Opaque transaction identifier. Echo it back; never parse it.',
      minLength: 1,
      maxLength: 128,
      examples: ['55555555-5555-4555-8555-000000000001'],
      type: 'string',
    });
  });

  it('states no format, so the provider keeps its key scheme', () => {
    expect(emitted(TransactionId)).not.toHaveProperty('format');
    expect(emitted(TransactionId)).not.toHaveProperty('pattern');
  });

  it('is not hoisted into components, like every scalar here', () => {
    expect(emitted(TransactionId)).not.toHaveProperty('$id');
  });
});

describe('the transaction', () => {
  it('publishes the merchant, the amount, the instant and the two enums', () => {
    expect(emitted(Transaction)).toEqual({
      $id: 'Transaction',
      description: 'One transaction, as the dashboard and the list both render it.',
      additionalProperties: true,
      type: 'object',
      required: [
        'id',
        'bookedAt',
        'merchantName',
        'merchantCategory',
        'amount',
        'settlementState',
      ],
      properties: {
        id: emitted(TransactionId),
        bookedAt: {
          description: 'When the transaction reached the ledger. Orders the list.',
          format: 'date-time',
          examples: ['2026-09-08T07:41:00Z'],
          type: 'string',
        },
        merchantName: {
          description: 'Merchant name as the acquirer reported it.',
          minLength: 1,
          examples: ['Scandic Malmo'],
          type: 'string',
        },
        merchantCategory: emitted(MerchantCategory),
        amount: emitted(MonetaryAmount),
        settlementState: emitted(TransactionSettlementState),
      },
    });
  });

  it('reuses the shared money component rather than forking one', () => {
    // Spreading `MonetaryAmount` to add a field-specific description would
    // hoist a second component under the same `$id`, and the money convention
    // is the one thing in this contract that must read identically everywhere.
    // The `$id` surviving in place is what says this is the shared shape — the
    // constraint itself is `shared.test.ts`'s to own.
    expect(properties(Transaction)['amount']?.['$id']).toBe('MonetaryAmount');
  });

  it('publishes money as a signed integer pair, never a formatted string', () => {
    const amount = properties(Transaction)['amount'] as Record<string, Record<string, unknown>>;
    const minorUnits = (amount['properties'] as Record<string, Record<string, unknown>>)['minorUnits'];

    expect(minorUnits?.['type']).toBe('integer');
    // Unsigned would push a refund into a second field or a transaction type,
    // which is how a total ends up computed with the wrong one.
    expect(minorUnits).not.toHaveProperty('minimum');
  });

  it('keeps the annotation of the shared instant while restating its meaning', () => {
    // The field reuses `Timestamp` by spread. That keeps `format: 'date-time'`
    // — which a mock server generates from and a consumer's codegen reads — and
    // overrides only the description. A hand-written copy would drift from the
    // shared schema silently, since no gate compares the two.
    expect(properties(Transaction)['bookedAt']?.['format']).toBe('date-time');
  });

  it('carries no card or company id, which the caller already selected', () => {
    // A second source of the same truth is one the provider then owes a
    // consumer consistency on.
    expect(Object.keys(properties(Transaction))).toEqual([
      'id',
      'bookedAt',
      'merchantName',
      'merchantCategory',
      'amount',
      'settlementState',
    ]);
  });

  it('publishes no dispute status, which folding disputed onto pending gives up', () => {
    // Deliberate, and the cheap direction to be wrong in: the screen has no
    // dispute UI, and adding a field when it grows one is the additive change
    // spec §6.1 lets a consumer ship the same day. Removing one is what forces
    // spec §6.2's major version.
    expect(Object.keys(properties(Transaction))).not.toContain('disputed');
    expect(Object.keys(properties(Transaction))).not.toContain('dispute');
  });

  it('makes every field required, so a consumer needs no absence handling', () => {
    // Unlike `Card.activatedAt`, nothing here is conditional on state: every
    // transaction has all six, whatever the settlement state.
    expect(emitted(Transaction)['required']).toEqual(Object.keys(properties(Transaction)));
  });

  it('is hoisted into components under a stable name', () => {
    // Reused by the dashboard and by the paginated transaction list.
    expect(emitted(Transaction)['$id']).toBe('Transaction');
  });

  it('tolerates unknown fields, like every response in this contract', () => {
    expect(emitted(Transaction)['additionalProperties']).toBe(true);
  });
});
