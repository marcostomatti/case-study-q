import type { TSchema } from '@sinclair/typebox';

import { describe, expect, it } from 'vitest';

import { CARD_STATES, Card, CardId, CardState } from './card';

/**
 * What this file pins that `card.test-d.ts` cannot: the JSON this card
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

/** The states `cards.lifecycle_status` declares, spelled out rather than imported. */
const DATABASE_LIFECYCLE_STATES = ['ordered', 'issued', 'active', 'frozen', 'terminated'];

describe('the card state enum', () => {
  it('publishes a JSON Schema enum, not an anyOf of consts', () => {
    // `Type.Union([Type.Literal(...)])` — the idiomatic TypeBox spelling —
    // emits `anyOf`, which house rule 3's `given: $..[?(@.enum)]` never
    // selects. The rule would load, report nothing, and count toward coverage
    // while spec §2.5 stopped being enforced on the enum most likely to grow a
    // member.
    expect(emitted(CardState)).toEqual({
      type: 'string',
      enum: ['inactive', 'active', 'frozen', 'closed', 'unknown'],
      description: 'Card state. Unrecognised values are `unknown`.',
    });
  });

  it('carries the unknown member spec §2.5 requires', () => {
    // The database enum has no such member and must not: every value in it is
    // one the schema declared. This one has a reader that can be older than the
    // provider, which is the whole difference.
    expect(emitted(CardState)['enum']).toContain('unknown');
  });

  it('is coarser than the database lifecycle it maps from', () => {
    // `ordered` and `issued` are the provider's issuing pipeline, and both fold
    // onto `inactive`; `terminated` is published as `closed`. A consumer
    // branches on whether the card is usable, not on where it sits in that
    // pipeline. This case is what fails if someone "aligns" the two
    // vocabularies — which would make every database rename a breaking change.
    for (const state of DATABASE_LIFECYCLE_STATES) {
      if (state === 'active' || state === 'frozen') continue;
      expect(CARD_STATES as readonly string[]).not.toContain(state);
    }

    expect(CARD_STATES.length).toBeLessThan(DATABASE_LIFECYCLE_STATES.length + 1);
  });

  it('keeps the vocabulary unique and machine-readable', () => {
    // A duplicate is invisible in a list and reaches the emitted document as
    // one. A member with a space or a capital is not something a consumer
    // switches on comfortably.
    expect([...new Set(CARD_STATES)]).toEqual([...CARD_STATES]);
    expect(CARD_STATES.filter((state) => !/^[a-z][a-z0-9_]*$/.test(state))).toEqual([]);
  });
});

describe('the card identifier', () => {
  it('publishes as an opaque bounded string, like the company id', () => {
    expect(emitted(CardId)).toEqual({
      description: 'Opaque card identifier. Echo it back; never parse it.',
      minLength: 1,
      maxLength: 64,
      examples: ['22222222-2222-4222-8222-222222222222'],
      type: 'string',
    });
  });

  it('states no format, so the provider keeps its key scheme', () => {
    expect(emitted(CardId)).not.toHaveProperty('format');
    expect(emitted(CardId)).not.toHaveProperty('pattern');
  });

  it('is not hoisted into components, like every scalar here', () => {
    expect(emitted(CardId)).not.toHaveProperty('$id');
  });
});

describe('the card', () => {
  it('publishes the artwork, the digits, the state and the activation', () => {
    expect(emitted(Card)).toEqual({
      $id: 'Card',
      description: 'The card the dashboard renders and the activation returns.',
      additionalProperties: true,
      type: 'object',
      required: ['id', 'lastFour', 'state', 'artUrl'],
      properties: {
        id: emitted(CardId),
        lastFour: {
          description: 'Last four digits of the card number. Mask them client-side.',
          pattern: '^[0-9]{4}$',
          minLength: 4,
          maxLength: 4,
          examples: ['4321'],
          type: 'string',
        },
        state: emitted(CardState),
        artUrl: {
          description: 'Absolute URL of the card artwork, resolved by the provider.',
          format: 'uri',
          minLength: 1,
          examples: ['https://cdn.example.com/card-art/business-black-v2.png'],
          type: 'string',
        },
        activatedAt: {
          description: 'When the cardholder activated the card. Absent if not.',
          format: 'date-time',
          examples: ['2026-09-08T07:41:00Z'],
          type: 'string',
        },
      },
    });
  });

  it('admits four digits and refuses a full card number', () => {
    // An unanchored pattern matches a PAN's last four anywhere inside it, which
    // is the mistake that turns a masked suffix into a place a full number
    // fits. The bounds and the anchors are two independent guards and both are
    // read here.
    const lastFour = properties(Card)['lastFour'];
    const pattern = new RegExp(String(lastFour?.['pattern']));

    expect(pattern.test('4321')).toBe(true);
    expect(pattern.test('4111111111111111')).toBe(false);
    expect(pattern.test('43a1')).toBe(false);
    expect(lastFour?.['maxLength']).toBe(4);
  });

  it('publishes the digits rather than a rendered mask', () => {
    // A consumer draws `•••• 4321` however its platform draws it. Publishing
    // the mask would move the provider's formatting into every consumer, the
    // same mistake a preformatted money string would be.
    expect(properties(Card)['lastFour']?.['examples']).toEqual(['4321']);
  });

  it('publishes a resolved URL rather than the database asset key', () => {
    // The column holds an opaque key (`card-art/business-black-v2`). Publishing
    // it would make the provider's asset store a consumer dependency and turn a
    // CDN move into a contract change.
    expect(properties(Card)['artUrl']?.['format']).toBe('uri');
    expect(String(properties(Card)['artUrl']?.['examples']?.[0])).toMatch(/^https:\/\//);
  });

  it('makes the activation instant absent rather than null', () => {
    // The column behind it is nullable and that nullability is the one fact the
    // contract must not inherit: spec §2.5 says absent means not applicable,
    // and house rule 6 rejects both spellings of the alternative — a
    // `nullable: true` flag and a `type` array carrying `null`.
    expect(emitted(Card)['required']).not.toContain('activatedAt');
    expect(properties(Card)['activatedAt']).not.toHaveProperty('nullable');
    expect(properties(Card)['activatedAt']?.['type']).toBe('string');
  });

  it('keeps the annotation of the shared instant while restating its meaning', () => {
    // The field reuses `Timestamp` by spread. That keeps `format: 'date-time'`
    // — which a mock server generates from and a consumer's codegen reads — and
    // overrides only the description. A hand-written copy of the shared schema
    // would drift from it silently.
    expect(properties(Card)['activatedAt']?.['format']).toBe('date-time');
  });

  it('carries no company id, which the caller already selected', () => {
    // A second source of the same truth is one the provider then owes a
    // consumer consistency on.
    expect(Object.keys(properties(Card))).toEqual([
      'id',
      'lastFour',
      'state',
      'artUrl',
      'activatedAt',
    ]);
  });

  it('is hoisted into components under a stable name', () => {
    // Reused by the dashboard and by the activation response.
    expect(emitted(Card)['$id']).toBe('Card');
  });

  it('tolerates unknown fields, like every response in this contract', () => {
    expect(emitted(Card)['additionalProperties']).toBe(true);
  });
});
