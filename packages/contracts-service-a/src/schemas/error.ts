/**
 * The shared error schema. Every error response of every operation in this
 * contract references this one shape, and house rule 5 fails the build of any
 * that does not.
 *
 * One shape rather than one per operation is the whole point. A consumer writes
 * a single error path and reuses it everywhere; a provider adding an operation
 * cannot invent a fifth spelling of "what went wrong"; and the retirement and
 * major-version workflows in spec §6 have one schema to reason about instead of
 * one per endpoint.
 *
 * ## Three decisions worth knowing before editing this file
 *
 * - **`$id` is `Error`, and that string is load-bearing.** House rule 5 runs
 *   against the unresolved document and requires every 4xx and 5xx response to
 *   carry a literal `{"$ref": "#/components/schemas/Error"}`. `emitOpenApi`
 *   hoists a schema into `components.schemas` under its `$id`, so renaming this
 *   one does not produce a differently-named component — it produces a contract
 *   that fails gate 2.
 * - **`code` is a real JSON Schema `enum`, built with `Type.Unsafe`.** The
 *   obvious TypeBox spelling, `Type.Union([Type.Literal(...)])`, emits `anyOf`
 *   of `const`s. That is an enum a human reads as an enum and that house rule 3
 *   — whose `given` selects nodes carrying `enum` — never sees, so the
 *   `unknown` member would stop being enforced for this contract's most
 *   reused schema.
 * - **`fields` is absent when there is nothing to say**, never `null` and never
 *   `[]`. One convention for empty (spec §2.5), and an empty array is a third
 *   spelling of it.
 */
import type { Static } from '@sinclair/typebox';

import { Type } from '@sinclair/typebox';

import { responseObject } from './shared';

/**
 * The component name this schema is published under, fixed by house rule 5's
 * `#/components/schemas/Error`. Exported so the contract module can state the
 * dependency rather than repeat the literal.
 */
export const ERROR_SCHEMA_ID = 'Error';

/**
 * The error catalogue: what a consumer switches on.
 *
 * Deliberately coarse. A code exists so a consumer can branch — retry, re-auth,
 * show the field errors, give up — and a catalogue with one code per failure
 * inside the provider is a catalogue that changes whenever the provider's
 * internals do. The human-readable `message` carries the detail.
 *
 * `unknown` is the member spec §2.5 requires and house rule 3 enforces, and it
 * is read in both directions: a provider that has to report a failure this
 * catalogue does not name emits it rather than inventing a code no consumer
 * knows, and a consumer that receives a code its pinned contract version
 * predates folds it onto `unknown` rather than throwing. Adding a member here
 * is therefore survivable — which is the only reason it is allowed at all,
 * under the major-version procedure in spec §6.2.
 */
export const ERROR_CODES = [
  // The request did not satisfy the contract: a malformed value, a missing
  // required field, or an unknown one (spec §2.5 request strictness). `fields`
  // names which.
  'validation_failed',
  // No usable `client_id` on the request. Spec §2.3 requires one on every
  // request, so this is the failure of the identity check rather than of any
  // one operation.
  'unauthenticated',
  // The addressed thing does not exist, or is not this consumer's to see. One
  // code for both on purpose: distinguishing them tells an unauthorised caller
  // which identifiers are real.
  'not_found',
  // The request was well-formed but the thing is not in a state that allows
  // it — activating a card that is already active.
  'conflict',
  // The provider failed. Nothing about the request needs to change; retrying
  // is reasonable.
  'internal_error',
  // Not in this catalogue. See the note above: emitted by the provider, and
  // folded onto by the consumer.
  'unknown',
] as const;

/** The union a consumer's `switch` is exhaustive against. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * `code` as a schema.
 *
 * `Type.Unsafe` is what emits a JSON Schema `enum` array with the TypeScript
 * union still attached — see the header for why `Type.Union` of literals is the
 * wrong tool here despite being the idiomatic TypeBox one.
 */
export const ErrorCode = Type.Unsafe<ErrorCode>({
  type: 'string',
  enum: [...ERROR_CODES],
  description: 'Machine-readable error code. Unrecognised values are `unknown`.',
});

/**
 * Where in the request the problem is: a dotted path from the payload root,
 * with array positions as indices.
 *
 * Dotted rather than a JSON Pointer because the consumers here are TypeScript
 * clients binding to form fields, and `page.limit` is what they already call
 * that field. A pointer would be more standard and less used.
 */
const FieldPath = Type.String({
  description: 'Dotted path from the request root to the offending field.',
  minLength: 1,
  examples: ['page.limit'],
});

/**
 * The error payload. Every 4xx and 5xx response in this contract is this shape.
 *
 * `message` is for a human reading a log or a support ticket, not for a
 * consumer to parse or display verbatim — it is free to change wording without
 * a version bump, which is precisely what `code` exists to be stable instead
 * of. It carries no stack trace, no SQL and no identifier the caller did not
 * already send.
 */
export const ErrorResponse = responseObject({
  code: ErrorCode,
  message: Type.String({
    description: 'Human-readable description of the failure, for diagnosis.',
    minLength: 1,
    examples: ['limit must be between 1 and 100'],
  }),
  fields: Type.Optional(Type.Array(FieldPath, {
    description:
      'Which request fields are at fault. Absent when no single field is.',
    minItems: 1,
  })),
}, {
  $id: ERROR_SCHEMA_ID,
  description: 'The shared error payload every error response carries.',
});
export type ErrorResponse = Static<typeof ErrorResponse>;
