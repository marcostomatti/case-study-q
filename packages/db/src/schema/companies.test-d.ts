import type { Company, NewCompany } from './companies';

import { expectTypeOf } from 'vitest';

/**
 * Type-level cases for the `companies` row types, and a note on which gate
 * actually runs them.
 *
 * These are `.test-d.ts`, not `.test.ts`, on purpose. The leaf `tsconfig.json`
 * excludes `**\/*.test.ts` — parity with the root, because vitest transpiles
 * test files without checking them — so an `expectTypeOf` written in a
 * `.test.ts` here is read by nothing at all and passes forever. Measured:
 * `bunx tsc --noEmit --listFiles` names `*.test-d.ts` and omits `*.test.ts`,
 * and a deliberately wrong expectation below fails `bun run check-types` with
 * `TS2344 ... Expected: <x>, Actual: <y>`.
 *
 * So `bun run check-types` is the gate for this file and `bun run test` is the
 * gate for `companies.test.ts`. The split is not cosmetic: an inferred row
 * type is erased before any test runs, and a SQL column name never reaches a
 * type. Neither file can make the other's claim.
 *
 * The expectations are spelled out as literal object types rather than derived
 * from the table. A derivation would agree with the schema whatever it said,
 * which is the one thing a pin must not do.
 */

/**
 * Every column is `NOT NULL`, so nothing here is optional or nullable. That is
 * a property worth pinning rather than assuming: a column relaxed to nullable
 * in a later migration turns its contract-side mapping into a decision about
 * spec §2.5's "absent means not applicable", and this case is where that shows
 * up first.
 */
expectTypeOf<Company>().toEqualTypeOf<{
  id: string;
  registeredLegalName: string;
  displayName: string;
  organisationNumber: string;
  defaultCurrencyCode: string;
}>();

/**
 * `id` is optional on insert and nothing else is — the type-level shadow of
 * `.defaultRandom()`, asserted at runtime in `companies.test.ts`. The currency
 * staying required is the load-bearing half: money in this repo is an integer
 * minor-unit amount plus an explicit ISO-4217 code, and a SQL default here
 * would quietly make the code omittable.
 */
expectTypeOf<NewCompany>().toEqualTypeOf<{
  id?: string | undefined;
  registeredLegalName: string;
  displayName: string;
  organisationNumber: string;
  defaultCurrencyCode: string;
}>();
