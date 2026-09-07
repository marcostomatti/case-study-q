import type { TSchema } from '@sinclair/typebox';

import { describe, expect, it } from 'vitest';

import { CompanyId, CompanySummary } from './company';

/**
 * What this file pins that `company.test-d.ts` cannot: the JSON the company
 * selector's schema publishes. A `Static<>` type carries neither the bounds,
 * nor the `$id` the emitter hoists on, nor the absence of a `format` — and
 * those are the whole of what a consumer, the Prism mock and `oasdiff` read.
 *
 * See `shared.test.ts` for why every assertion is over the JSON round trip.
 */
const emitted = (schema: TSchema): Record<string, unknown> => JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;

const properties = (schema: TSchema): Record<string, Record<string, unknown>> => (
  emitted(schema)['properties'] as Record<string, Record<string, unknown>>
);

describe('the company identifier', () => {
  it('publishes as an opaque bounded string', () => {
    expect(emitted(CompanyId)).toEqual({
      description: 'Opaque company identifier. Echo it back; never parse it.',
      minLength: 1,
      maxLength: 64,
      examples: ['11111111-1111-4111-8111-111111111111'],
      type: 'string',
    });
  });

  it('states no format, so the provider keeps its key scheme', () => {
    // The column behind this is a `uuid` today. `format: 'uuid'` here would
    // publish that and make migrating off it a contract change — the same
    // reason `MonetaryAmount` states no ceiling for a 32-bit column. This case
    // is what fails when someone adds the format back as a "tightening".
    expect(emitted(CompanyId)).not.toHaveProperty('format');
    expect(emitted(CompanyId)).not.toHaveProperty('pattern');
  });

  it('bounds a value that arrives in a request path', () => {
    // An identifier the caller supplies is untrusted input, and a bound stated
    // in the document is one a consumer can read rather than discover from a
    // rejection.
    expect(emitted(CompanyId)['maxLength']).toBe(64);
  });

  it('is not hoisted into components, like every scalar here', () => {
    // `emitOpenApi` hoists on `$id`. A component per string type puts the
    // constraint one indirection away from the field it constrains, and a path
    // parameter could not reference it anyway — those are exploded into
    // `parameters`.
    expect(emitted(CompanyId)).not.toHaveProperty('$id');
  });

  it('illustrates with the identifier the seed inserts', () => {
    // Spelled as a literal rather than imported: this package must not depend
    // on `@marcos-corp/db` (spec §2.1), and `assertNoDbImport` fails the build
    // if it does. Matching matters because the Prism mock generates from the
    // example, so the mock and a running `service-a` answer alike — which is
    // what makes the mock usable for the unblocking workflow in spec §6.1.
    expect(emitted(CompanyId)['examples']).toEqual([
      '11111111-1111-4111-8111-111111111111',
    ]);
  });
});

describe('the company summary', () => {
  it('publishes an id and a name, both required, and nothing else', () => {
    expect(emitted(CompanySummary)).toEqual({
      $id: 'CompanySummary',
      description: 'A company as the selector lists it.',
      additionalProperties: true,
      type: 'object',
      required: ['id', 'name'],
      properties: {
        id: emitted(CompanyId),
        name: {
          description: 'The company name the selector renders.',
          minLength: 1,
          examples: ['Company AB'],
          type: 'string',
        },
      },
    });
  });

  it('publishes none of the company columns the selector does not render', () => {
    // The table carries a registered legal name, an organisation number and a
    // default currency. Publishing a required response field is the expensive
    // direction — removing one later is breaking and forces spec §6.2's major
    // version — while adding one is the additive change a consumer can author
    // and ship the same day (spec §6.1). A schema derived from the table would
    // publish all four because they happen to be there.
    expect(Object.keys(properties(CompanySummary))).toEqual(['id', 'name']);
  });

  it('publishes one name where the database keeps two columns', () => {
    // `display_name` and `registered_legal_name` are separate facts. Which one
    // feeds this field is `service-a`'s mapping decision, and moving it is a
    // provider-side change no consumer can see.
    expect(properties(CompanySummary)['name']?.['description'])
      .toBe('The company name the selector renders.');
    expect(properties(CompanySummary)['name']?.['examples']).toEqual(['Company AB']);
  });

  it('forbids an empty name, the second spelling of nothing', () => {
    // Spec §2.5 allows one spelling of empty, and it is absence. An empty
    // string here would be a second.
    expect(properties(CompanySummary)['name']?.['minLength']).toBe(1);
  });

  it('is hoisted into components under a stable name', () => {
    // Reused by the company list and by the dashboard's selected company. One
    // component means an edit reads as a single change in the diff gate rather
    // than one per usage.
    expect(emitted(CompanySummary)['$id']).toBe('CompanySummary');
  });

  it('tolerates unknown fields, like every response in this contract', () => {
    // Spec §2.5's response half: a consumer pinned to an older version must
    // survive a field that version predates.
    expect(emitted(CompanySummary)['additionalProperties']).toBe(true);
  });
});
