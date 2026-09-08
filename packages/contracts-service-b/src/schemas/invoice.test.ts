import type { TSchema } from '@sinclair/typebox';

import { describe, expect, it } from 'vitest';

import {
  INVOICE_PAYMENT_STATES,
  Invoice,
  InvoiceId,
  InvoicePaymentState,
} from './invoice';
import { CalendarDate, MonetaryAmount } from './shared';

/**
 * What this file pins that `invoice.test-d.ts` cannot: the JSON this invoice
 * publishes, and in particular the `enum` keyword house rule 3 selects on. A
 * `Static<>` type is the same union whether the schema emits `enum` or the
 * `anyOf` of `const`s that would leave spec §2.5 unenforced here — so the two
 * suites are not two opinions about one thing.
 *
 * See `shared.test.ts` for why every assertion is over the JSON round trip.
 */
const emitted = (schema: TSchema): Record<string, unknown> => JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;

const properties = (schema: TSchema): Record<string, Record<string, unknown>> => (
  emitted(schema)['properties'] as Record<string, Record<string, unknown>>
);

/** The states `invoices.payment_state` declares, spelled out rather than imported. */
const DATABASE_PAYMENT_STATES = ['draft', 'issued', 'paid', 'written_off'];

describe('the payment state enum', () => {
  it('publishes a JSON Schema enum, not an anyOf of consts', () => {
    // `Type.Union([Type.Literal(...)])` — the idiomatic TypeBox spelling —
    // emits `anyOf`, which house rule 3's `given: $..[?(@.enum)]` never
    // selects. The rule would load, report nothing, and count toward coverage
    // while spec §2.5 stopped being enforced on the enum most likely to grow a
    // member.
    expect(emitted(InvoicePaymentState)).toEqual({
      type: 'string',
      enum: ['awaiting_payment', 'paid', 'cancelled', 'unknown'],
      description: 'Invoice payment state. Unrecognised values are `unknown`.',
    });
  });

  it('carries the unknown member spec §2.5 requires', () => {
    // The database enum has no such member and must not: every value in it is
    // one the schema declared. This one has a reader that can be older than the
    // provider, which is the whole difference.
    expect(emitted(InvoicePaymentState)['enum']).toContain('unknown');
  });

  it('is spelled differently from the database vocabulary it maps from', () => {
    // The case that fails if someone "aligns" the two vocabularies — which
    // would make every database rename a breaking change and would drag the
    // provider's `draft` into the published surface.
    for (const state of DATABASE_PAYMENT_STATES) {
      if (state === 'paid') continue;
      expect(INVOICE_PAYMENT_STATES as readonly string[]).not.toContain(state);
    }
  });

  it('gives the provider-internal draft state no published member at all', () => {
    // An invoice the company has not been sent does not exist as far as a
    // consumer is concerned. Publishing a name for it would oblige this
    // provider to keep emitting one.
    expect(INVOICE_PAYMENT_STATES as readonly string[]).not.toContain('draft');
    // The inverting half: the states it *does* publish, so a leg that empties
    // the list cannot satisfy the absence above.
    expect(INVOICE_PAYMENT_STATES as readonly string[]).toContain('awaiting_payment');
  });

  it('publishes no state derived from a comparison against today', () => {
    // `overdue` is `dueOn` against today, in the consumer's own timezone.
    // A provider-computed flag goes stale at midnight with nothing to
    // recompute it — the same argument `packages/db` makes for the column.
    expect(INVOICE_PAYMENT_STATES as readonly string[]).not.toContain('overdue');
    expect(INVOICE_PAYMENT_STATES as readonly string[]).not.toContain('due');
  });

  it('keeps the vocabulary unique and machine-readable', () => {
    // A duplicate is invisible in a list and reaches the emitted document as
    // one. A member with a space or a capital is not something a consumer
    // switches on comfortably.
    expect([...new Set(INVOICE_PAYMENT_STATES)]).toEqual([...INVOICE_PAYMENT_STATES]);
    expect(INVOICE_PAYMENT_STATES.filter((state) => !/^[a-z][a-z0-9_]*$/.test(state))).toEqual([]);
  });
});

describe('the invoice identifier', () => {
  it('publishes as an opaque bounded string, like the company id', () => {
    expect(emitted(InvoiceId)).toEqual({
      description: 'Opaque invoice identifier. Echo it back; never parse it.',
      minLength: 1,
      maxLength: 64,
      examples: ['33333333-3333-4333-8333-333333333333'],
      type: 'string',
    });
  });

  it('states no format, so the provider keeps its key scheme', () => {
    expect(emitted(InvoiceId)).not.toHaveProperty('format');
    expect(emitted(InvoiceId)).not.toHaveProperty('pattern');
  });

  it('is not hoisted into components, like every scalar here', () => {
    expect(emitted(InvoiceId)).not.toHaveProperty('$id');
  });
});

describe('the invoice', () => {
  it('publishes the identifier, the due day, the amount and the state', () => {
    expect(emitted(Invoice)).toEqual({
      $id: 'Invoice',
      description: 'An invoice as the mobile view\'s `Invoice due` banner renders it.',
      additionalProperties: true,
      type: 'object',
      required: ['id', 'dueOn', 'total', 'paymentState'],
      properties: {
        id: emitted(InvoiceId),
        dueOn: {
          description: 'The day the invoice falls due, in the company\'s jurisdiction.',
          format: 'date',
          pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
          minLength: 10,
          maxLength: 10,
          examples: ['2026-09-20'],
          type: 'string',
        },
        total: emitted(MonetaryAmount),
        paymentState: emitted(InvoicePaymentState),
      },
    });
  });

  it('reuses the shared calendar date rather than restating it', () => {
    // The spread copies TypeBox's `Kind` symbol, so `dueOn` is still the same
    // schema with a field-specific description. `format` is the inherited
    // annotation that says the spread happened: a hand-written
    // `Type.String({ pattern })` copy would pass every other assertion here and
    // then drift from `CalendarDate` with no gate comparing the two.
    expect(properties(Invoice)['dueOn']?.['format']).toBe(emitted(CalendarDate)['format']);
    expect(properties(Invoice)['dueOn']?.['pattern']).toBe(emitted(CalendarDate)['pattern']);
  });

  it('references the shared money component rather than spreading it', () => {
    // A spread would produce a second schema carrying `$id: 'MonetaryAmount'`
    // with different content, and gate 1 refuses that outright — two schemas
    // publishing under one component name. The surviving `$id` is what says the
    // reference is intact; `shared.test.ts` owns the shape itself.
    expect(properties(Invoice)['total']?.['$id']).toBe('MonetaryAmount');
  });

  it('publishes no companyId, since the path already names the company', () => {
    // A second source of the same truth is one the provider would then owe
    // consistency on.
    expect(Object.keys(properties(Invoice))).not.toContain('companyId');
  });

  it('publishes no figure derived from today', () => {
    // The inverting half of the enum's `overdue` case: a leg that adds the
    // staleness back as a field rather than as a state has to fail here.
    for (const field of ['overdue', 'isOverdue', 'daysUntilDue', 'daysOverdue']) {
      expect(Object.keys(properties(Invoice))).not.toContain(field);
    }

    // The control: the fields it does publish, so an empty property map cannot
    // satisfy the absences above.
    expect(Object.keys(properties(Invoice))).toEqual(['id', 'dueOn', 'total', 'paymentState']);
  });

  it('tolerates unknown fields and hoists into components', () => {
    // Hoisted because it is what the operation returns — the name a consumer's
    // client binds to and the one the diff gate reports changes against.
    expect(emitted(Invoice)['additionalProperties']).toBe(true);
    expect(emitted(Invoice)['$id']).toBe('Invoice');
  });

  it('makes every published field required, so a consumer never checks for one', () => {
    expect(emitted(Invoice)['required']).toEqual(Object.keys(properties(Invoice)));
  });
});
