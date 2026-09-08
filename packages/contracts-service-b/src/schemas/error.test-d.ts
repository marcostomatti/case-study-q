import type { ErrorCode, ErrorResponse } from './error';

import { expectTypeOf } from 'vitest';

/**
 * Type-level cases for the error payload. Read by `bun run check-types`, not by
 * `bun run test` — see the header of `shared.test-d.ts` for the split.
 */

/**
 * The union a consumer's error path switches on, `unknown` included.
 *
 * Deliberately not the same list as `contracts-service-a`'s: two independently
 * versioned contracts state their own catalogues, and this one has no operation
 * that can conflict.
 */
expectTypeOf<ErrorCode>()
  .toEqualTypeOf<'validation_failed' | 'unauthenticated' | 'not_found' | 'internal_error' | 'unknown'>();

/**
 * `code` is the narrow union rather than `string` — what `Type.Unsafe` buys and
 * a bare `Type.String({ enum })` does not. `fields` is optional and possibly
 * `undefined`, never `null` (spec §2.5).
 */
expectTypeOf<ErrorResponse>().toEqualTypeOf<{
  code: ErrorCode;
  message: string;
  fields?: string[] | undefined;
}>();
