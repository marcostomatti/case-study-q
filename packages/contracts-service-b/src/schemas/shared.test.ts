import type { TSchema } from '@sinclair/typebox';

import { describe, expect, it } from 'vitest';

import {
  CalendarDate,
  CompanyId,
  CurrencyCode,
  MonetaryAmount,
  requestObject,
  responseObject,
} from './shared';

/**
 * What this file pins that `shared.test-d.ts` cannot: the JSON these schemas
 * publish. A `Static<>` type says nothing about a `pattern`, a `format`, a
 * bound, an `$id` or an `additionalProperties`, and those are the whole of what
 * a consumer, a mock server and `oasdiff` read.
 *
 * Every assertion is over `JSON.parse(JSON.stringify(schema))` rather than over
 * the schema object. TypeBox attaches its own `Kind` symbols, which no gate in
 * this repo ever sees; the JSON round trip is exactly the reduction
 * `emitOpenApi` writes into the document.
 *
 * Gate 2 makes the house-rule claim about the *emitted document*. These cases
 * make it about the schemas themselves, which is where the fix goes when it
 * fails.
 */
const emitted = (schema: TSchema): Record<string, unknown> => JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;

describe('the object builders', () => {
  it('has responseObject tolerate unknown fields, per spec §2.5', () => {
    // The provider deploys before the consumer adopts, so a consumer pinned to
    // an older version routinely sees fields that version predates.
    expect(emitted(responseObject({}))['additionalProperties']).toBe(true);
  });

  it('has requestObject reject unknown fields, per spec §2.5', () => {
    expect(emitted(requestObject({}))['additionalProperties']).toBe(false);
  });

  it('refuses to let a call site reverse the direction', () => {
    // The type half of this is the `@ts-expect-error` case in
    // `shared.test-d.ts`. This half covers the other way it could break: the
    // options spread landing *after* `additionalProperties` rather than before.
    const options = { additionalProperties: false } as never;

    expect(emitted(responseObject({}, options))['additionalProperties']).toBe(true);
    expect(emitted(requestObject({}, { $id: 'X' }))['additionalProperties']).toBe(false);
  });

  it('passes every option a contract author may set straight through', () => {
    expect(emitted(responseObject({}, {
      $id: 'Probe',
      title: 'Probe',
      description: 'A probe.',
      deprecated: true,
      'x-sunset': '2027-01-01',
      examples: [{}],
    }))).toEqual({
      $id: 'Probe',
      title: 'Probe',
      description: 'A probe.',
      deprecated: true,
      'x-sunset': '2027-01-01',
      examples: [{}],
      type: 'object',
      additionalProperties: true,
      // An object with no properties still emits an empty `properties` map —
      // but no `required` key at all, rather than an empty list. An absent key
      // and an empty array are different documents; assert whichever is true.
      properties: {},
    });
  });
});

describe('the currency code', () => {
  it('publishes as a bounded, patterned string rather than an enum', () => {
    // An enum would drag house rule 3's `unknown` member in, which for a
    // published external standard is noise: ISO-4217 is not this provider's
    // vocabulary to extend.
    expect(emitted(CurrencyCode)).toEqual({
      description: 'ISO-4217 alphabetic currency code, uppercase.',
      pattern: '^[A-Z]{3}$',
      minLength: 3,
      maxLength: 3,
      examples: ['SEK'],
      type: 'string',
    });
    expect(emitted(CurrencyCode)).not.toHaveProperty('enum');
  });
});

describe('the monetary amount', () => {
  it('publishes integer minor units paired with the currency counting them', () => {
    expect(emitted(MonetaryAmount)).toEqual({
      $id: 'MonetaryAmount',
      description:
        'An amount of money as an integer count of a currency\'s minor unit.',
      type: 'object',
      additionalProperties: true,
      required: ['minorUnits', 'currency'],
      properties: {
        minorUnits: {
          description:
            'Signed amount in the currency\'s minor unit. 2 480,00 kr is 248000.',
          examples: [248000],
          type: 'integer',
        },
        currency: emitted(CurrencyCode),
      },
    });
  });

  it('states no minimum, so a credit note is expressible', () => {
    // A `minimum: 0` would push the sign into a second field or into a document
    // type, which is how a balance ends up computed with the wrong one.
    expect(emitted(MonetaryAmount)['properties']).toMatchObject({ minorUnits: {} });
    expect((emitted(MonetaryAmount)['properties'] as Record<string, Record<string, unknown>>)['minorUnits'])
      .not.toHaveProperty('minimum');
  });

  it('states no maximum, so widening the column is not a contract change', () => {
    // The column behind it is a 32-bit integer today. Publishing that ceiling
    // would make a provider-side migration visible to every consumer.
    expect((emitted(MonetaryAmount)['properties'] as Record<string, Record<string, unknown>>)['minorUnits'])
      .not.toHaveProperty('maximum');
  });

  it('is hoisted into components, because it is reused', () => {
    expect(emitted(MonetaryAmount)['$id']).toBe('MonetaryAmount');
  });
});

describe('the calendar date', () => {
  it('publishes as a day, never as an instant', () => {
    // The distinction is the point of the primitive: an instant carries a
    // time-of-day nobody chose and renders as the previous day for a reader in
    // another zone.
    expect(emitted(CalendarDate)).toEqual({
      description: 'A calendar day in the company\'s jurisdiction, as YYYY-MM-DD.',
      format: 'date',
      pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
      minLength: 10,
      maxLength: 10,
      examples: ['2026-09-20'],
      type: 'string',
    });
    expect(emitted(CalendarDate)['format']).not.toBe('date-time');
  });

  it('carries the pattern beside the format, not instead of it', () => {
    // `format` is an annotation a validator may ignore; the pattern is the half
    // that still constrains when it does. Losing either is a silent widening.
    expect(emitted(CalendarDate)).toHaveProperty('format');
    expect(emitted(CalendarDate)).toHaveProperty('pattern');
  });

  it('is not hoisted into components, like every scalar here', () => {
    expect(emitted(CalendarDate)).not.toHaveProperty('$id');
  });
});

describe('the company identifier', () => {
  it('publishes as an opaque bounded string', () => {
    expect(emitted(CompanyId)).toEqual({
      description: 'Opaque company identifier, as issued by service-a.',
      minLength: 1,
      maxLength: 64,
      examples: ['11111111-1111-4111-8111-111111111111'],
      type: 'string',
    });
  });

  it('states no format, so the provider keeps its key scheme', () => {
    // The column is a `uuid` today; publishing that would make migrating off it
    // a contract change.
    expect(emitted(CompanyId)).not.toHaveProperty('format');
    expect(emitted(CompanyId)).not.toHaveProperty('pattern');
  });

  it('is not hoisted, since a path parameter could not reference a component', () => {
    expect(emitted(CompanyId)).not.toHaveProperty('$id');
  });
});
