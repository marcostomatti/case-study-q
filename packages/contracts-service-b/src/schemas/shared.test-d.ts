import type {
  CalendarDate,
  CompanyId,
  ContractObjectOptions,
  CurrencyCode,
  MonetaryAmount,
} from './shared';

import { expectTypeOf } from 'vitest';

import { responseObject } from './shared';

/**
 * Type-level cases for the shared primitives. Read by `bun run check-types`,
 * not by `bun run test`: the leaf tsconfig excludes the `*.test.ts` glob, and
 * that glob does not match a `*.test-d.ts` sibling.
 *
 * The split from `shared.test.ts` is not redundancy. That file owns the
 * published JSON — patterns, formats, bounds, `$id`, `additionalProperties` —
 * none of which reaches a `Static<>` type. This file owns what a consumer's
 * TypeScript actually binds to, which no JSON assertion can state.
 */

/**
 * Money is a `number`, and this is the case that fails if it stops being one.
 *
 * `Type.Number()` in place of `Type.Integer()` is invisible here — both are
 * `number` — which is why `shared.test.ts` pins `type: 'integer'` separately.
 * What this catches is the other direction: a well-meant `Type.String()` for
 * "big amounts", which turns every arithmetic site in every consumer into
 * string concatenation.
 */
expectTypeOf<MonetaryAmount>().toEqualTypeOf<{ minorUnits: number; currency: string }>();

/** The scalars are plain strings; their constraints live in the JSON. */
expectTypeOf<CurrencyCode>().toEqualTypeOf<string>();
expectTypeOf<CompanyId>().toEqualTypeOf<string>();

/**
 * A calendar date is a `string`, deliberately — never a `Date`.
 *
 * `packages/db` pins the same decision on the column, for the same reason: a
 * `Date` for a calendar day carries a time-of-day nobody chose. This is the
 * consumer-side half of it, and the only gate that reads it.
 */
expectTypeOf<CalendarDate>().toEqualTypeOf<string>();

/**
 * The direction of `additionalProperties` is not a caller's to set. This is the
 * type half of the runtime case in `shared.test.ts`; together they cover both
 * ways the builders could stop enforcing spec §2.5 — a widened option type, and
 * a spread in the wrong order.
 */
// @ts-expect-error `additionalProperties` is decided by direction, not per call site.
responseObject({}, { additionalProperties: false } satisfies ContractObjectOptions);
