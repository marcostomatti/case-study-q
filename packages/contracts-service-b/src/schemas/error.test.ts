import type { TSchema } from '@sinclair/typebox';

import { describe, expect, it } from 'vitest';

import { ERROR_CODES, ERROR_SCHEMA_ID, ErrorCode, ErrorResponse } from './error';

/**
 * What this file pins that `error.test-d.ts` cannot: the `$id` house rule 5
 * hard-codes, and the `enum` keyword house rule 3 selects on. Both are invisible
 * in a `Static<>` type and both are the difference between a contract that
 * passes gate 2 and one that does not.
 *
 * See `shared.test.ts` for why every assertion is over the JSON round trip.
 */
const emitted = (schema: TSchema): Record<string, unknown> => JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;

describe('the error catalogue', () => {
  it('publishes a JSON Schema enum, not an anyOf of consts', () => {
    expect(emitted(ErrorCode)).toEqual({
      type: 'string',
      enum: ['validation_failed', 'unauthenticated', 'not_found', 'internal_error', 'unknown'],
      description: 'Machine-readable error code. Unrecognised values are `unknown`.',
    });
  });

  it('carries the unknown member spec §2.5 requires', () => {
    expect(emitted(ErrorCode)['enum']).toContain('unknown');
  });

  it('publishes no conflict code, because nothing here can be in the wrong state', () => {
    // This contract is one read. `contracts-service-a` publishes `conflict`
    // because it has a state change; copying its catalogue wholesale would
    // publish a code no operation here can ever emit.
    expect(ERROR_CODES as readonly string[]).not.toContain('conflict');
  });

  it('publishes no code naming the upstream this provider depends on', () => {
    // `service-b` resolves company context through `service-a`, and that is a
    // deployment fact rather than an API promise. A consumer's response to an
    // upstream failure is the same retry `internal_error` already asks for, so
    // a distinct code would publish this provider's dependency graph and buy
    // the consumer nothing.
    for (const code of ['upstream_unavailable', 'bad_gateway', 'service_a_unavailable']) {
      expect(ERROR_CODES as readonly string[]).not.toContain(code);
    }

    // The control: the code that failure is reported as, so an empty catalogue
    // cannot satisfy the absences above.
    expect(ERROR_CODES as readonly string[]).toContain('internal_error');
  });

  it('keeps the vocabulary unique and machine-readable', () => {
    expect([...new Set(ERROR_CODES)]).toEqual([...ERROR_CODES]);
    expect(ERROR_CODES.filter((code) => !/^[a-z][a-z0-9_]*$/.test(code))).toEqual([]);
  });
});

describe('the error payload', () => {
  it('is published under the component name house rule 5 hard-codes', () => {
    // The rule runs against the unresolved document and wants a literal
    // `{"$ref": "#/components/schemas/Error"}`. `emitOpenApi` hoists on `$id`,
    // so renaming this does not rename a component — it fails gate 2.
    expect(ERROR_SCHEMA_ID).toBe('Error');
    expect(emitted(ErrorResponse)['$id']).toBe('Error');
  });

  it('publishes a code, a message, and the fields at fault when there are any', () => {
    expect(emitted(ErrorResponse)).toEqual({
      $id: 'Error',
      description: 'The shared error payload every error response carries.',
      type: 'object',
      additionalProperties: true,
      required: ['code', 'message'],
      properties: {
        code: emitted(ErrorCode),
        message: {
          description: 'Human-readable description of the failure, for diagnosis.',
          minLength: 1,
          examples: ['companyId must be between 1 and 64 characters'],
          type: 'string',
        },
        fields: {
          description:
            'Which request fields are at fault. Absent when no single field is.',
          minItems: 1,
          type: 'array',
          items: {
            description: 'Dotted path from the request root to the offending field.',
            minLength: 1,
            examples: ['companyId'],
            type: 'string',
          },
        },
      },
    });
  });

  it('makes fields optional and never nullable', () => {
    // Absent when there is nothing to say — never `null`, and never `[]`, which
    // would be a third spelling of empty. `minItems: 1` is what forbids the
    // third one.
    expect(emitted(ErrorResponse)['required']).toEqual(['code', 'message']);
    expect(emitted(ErrorResponse)).not.toHaveProperty('nullable');
  });
});
