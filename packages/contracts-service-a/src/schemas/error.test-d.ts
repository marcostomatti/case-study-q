import type { ErrorCode, ErrorResponse } from './error';

import { expectTypeOf } from 'vitest';

/**
 * Type-level cases for the shared error schema. See the header of
 * `shared.test-d.ts` for which gate reads this file.
 */

/**
 * The union a consumer's `switch` is exhaustive against, `unknown` included.
 *
 * A consumer handling every member but `unknown` compiles today and breaks the
 * first time the provider reports something this catalogue does not name, which
 * is exactly what spec §2.5 requires the member for. Adding a code here is a
 * change every consumer sees in this type.
 */
expectTypeOf<ErrorCode>().toEqualTypeOf<
  'validation_failed' | 'unauthenticated' | 'not_found' | 'conflict' | 'internal_error' | 'unknown'
>();

/**
 * `code` is the narrow union rather than `string` — the reason the schema is
 * built with `Type.Unsafe` and not a bare `Type.String({ enum })`, which emits
 * the same JSON and hands consumers no union at all.
 *
 * `fields` is optional and never `null`: absent means no single field is at
 * fault (spec §2.5).
 */
expectTypeOf<ErrorResponse>().toEqualTypeOf<{
  code: ErrorCode;
  message: string;
  fields?: string[] | undefined;
}>();
