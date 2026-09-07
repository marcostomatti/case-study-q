import type { TSchema } from '@sinclair/typebox';

import { describe, expect, it } from 'vitest';

import { ERROR_CODES, ERROR_SCHEMA_ID, ErrorCode, ErrorResponse } from './error';

/** See `shared.test.ts` for why every assertion is over the JSON round trip. */
const emitted = (schema: TSchema): Record<string, unknown> => JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;

/**
 * The claims here are the ones the rest of this contract depends on and cannot
 * restate: the component name house rule 5 hard-codes, the `enum` keyword house
 * rule 3 selects on, and the `unknown` member it requires. Each of the three is
 * a silent gate-2 failure at the far end of a contract change if it drifts.
 */
describe('the shared error schema', () => {
  it('publishes under the component name house rule 5 hard-codes', () => {
    // `emitOpenApi` hoists on `$id`, and house rule 5 wants the literal
    // `#/components/schemas/Error` on every 4xx and 5xx response. Renaming this
    // does not rename the requirement.
    expect(ERROR_SCHEMA_ID).toBe('Error');
    expect(emitted(ErrorResponse)['$id']).toBe(ERROR_SCHEMA_ID);
  });

  it('publishes the code as a JSON Schema enum, not an anyOf of consts', () => {
    // `Type.Union([Type.Literal(...)])` — the idiomatic TypeBox spelling —
    // emits `anyOf`, which house rule 3's `given: $..[?(@.enum)]` never
    // selects. The rule would then be silently unenforced on this contract's
    // most reused schema.
    expect(emitted(ErrorCode)).toEqual({
      type: 'string',
      enum: [
        'validation_failed',
        'unauthenticated',
        'not_found',
        'conflict',
        'internal_error',
        'unknown',
      ],
      description: 'Machine-readable error code. Unrecognised values are `unknown`.',
    });
  });

  it('carries the unknown member spec §2.5 requires', () => {
    expect(emitted(ErrorCode)['enum']).toContain('unknown');
  });

  it('keeps the catalogue unique and machine-readable', () => {
    // A duplicate is invisible in a list this long, and reaches the emitted
    // document as a duplicate too. A code with a space or a capital in it is
    // not something a consumer can switch on comfortably.
    expect([...new Set(ERROR_CODES)]).toEqual([...ERROR_CODES]);
    expect(ERROR_CODES.filter((code) => !/^[a-z][a-z0-9_]*$/.test(code))).toEqual([]);
  });

  it('publishes a code, a message, and an optional list of field paths', () => {
    expect(emitted(ErrorResponse)).toEqual({
      $id: 'Error',
      description: 'The shared error payload every error response carries.',
      additionalProperties: true,
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: emitted(ErrorCode),
        message: {
          description: 'Human-readable description of the failure, for diagnosis.',
          minLength: 1,
          examples: ['limit must be between 1 and 100'],
          type: 'string',
        },
        fields: {
          description: 'Which request fields are at fault. Absent when no single field is.',
          minItems: 1,
          type: 'array',
          items: {
            description: 'Dotted path from the request root to the offending field.',
            minLength: 1,
            examples: ['page.limit'],
            type: 'string',
          },
        },
      },
    });
  });

  it('makes the field list absent rather than empty when nothing is at fault', () => {
    // Spec §2.5 allows one spelling of empty. `null` is rejected by house rule
    // 6; an empty array would be a third, so `minItems` forbids it and the
    // field stays out of `required`.
    expect(emitted(ErrorResponse)['required']).not.toContain('fields');

    const fields = (emitted(ErrorResponse)['properties'] as Record<string, Record<string, unknown>>)['fields'];

    expect(fields?.['minItems']).toBe(1);
  });

  it('tolerates unknown fields, like every other response in this contract', () => {
    // An error payload is a response, so the same half of spec §2.5 applies: a
    // provider adding a field to it must not break a consumer's error path.
    expect(emitted(ErrorResponse)['additionalProperties']).toBe(true);
  });
});
