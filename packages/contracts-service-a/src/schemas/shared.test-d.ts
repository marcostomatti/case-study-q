import type { ContractObjectOptions, CurrencyCode, MonetaryAmount, PageInfo, PaginationQuery, Timestamp } from './shared';
import type { Static } from '@sinclair/typebox';

import { expectTypeOf } from 'vitest';

import { MonetaryAmount as MonetaryAmountSchema, paginatedResponse, responseObject } from './shared';

/**
 * Type-level cases for the shared primitives. Read by `bun run check-types`,
 * not by `bun run test`: the leaf tsconfig excludes the `*.test.ts` glob, and
 * that glob does not match a `*.test-d.ts` sibling.
 *
 * The split from `shared.test.ts` is the same one `packages/db` draws between
 * its runtime and type suites, and it is not redundancy. That file owns the
 * published JSON — patterns, bounds, `$id`, `additionalProperties` — none of
 * which reaches a `Static<>` type. This file owns what a consumer's TypeScript
 * actually binds to, which no JSON assertion can state.
 */

/**
 * Money is a `number`, and this is the case that fails if it stops being one.
 *
 * `Type.Number()` in place of `Type.Integer()` is invisible here — both are
 * `number` — which is why `shared.test.ts` pins `type: 'integer'` separately.
 * What this catches is the other direction: a well-meant `Type.String()` for
 * "big amounts", which turns every arithmetic site in every consumer into
 * string concatenation. Same failure `packages/db` pins per money column.
 */
expectTypeOf<MonetaryAmount>().toEqualTypeOf<{ minorUnits: number; currency: string }>();

/** Both scalars are plain strings; their constraints live in the JSON. */
expectTypeOf<CurrencyCode>().toEqualTypeOf<string>();
expectTypeOf<Timestamp>().toEqualTypeOf<string>();

/** Every field of a page position is required — a consumer never checks for one. */
expectTypeOf<PageInfo>().toEqualTypeOf<{ limit: number; offset: number; total: number }>();

/**
 * Both query parameters are optional, and optional means possibly `undefined`
 * rather than possibly `null`. The absent-not-null convention of spec §2.5
 * reaches the TypeScript type as well as the document.
 */
expectTypeOf<PaginationQuery>().toEqualTypeOf<{
  limit?: number | undefined;
  offset?: number | undefined;
}>();

/**
 * The envelope carries the item type through. A helper that widened it to
 * `unknown[]` would still emit a correct document and still pass every case in
 * `shared.test.ts`, while handing consumers an untyped list.
 */
type MoneyPage = Static<ReturnType<typeof paginatedResponse<typeof MonetaryAmountSchema>>>;

expectTypeOf<MoneyPage>().toEqualTypeOf<{
  items: { minorUnits: number; currency: string }[];
  page: { limit: number; offset: number; total: number };
}>();

/**
 * The direction of `additionalProperties` is not a caller's to set. This is the
 * type half of the runtime case in `shared.test.ts`; together they cover both
 * ways the builders could stop enforcing spec §2.5 — a widened option type, and
 * a spread in the wrong order.
 */
// @ts-expect-error `additionalProperties` is decided by direction, not per call site.
responseObject({}, { additionalProperties: false } satisfies ContractObjectOptions);
