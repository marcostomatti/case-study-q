import type { Invoice, InvoiceId, InvoicePaymentState } from './invoice';

import { expectTypeOf } from 'vitest';

/**
 * Type-level cases for the invoice. Read by `bun run check-types`, not by
 * `bun run test` — see the header of `shared.test-d.ts` for the split.
 */

/** An identifier is a plain string; its bound lives in the JSON. */
expectTypeOf<InvoiceId>().toEqualTypeOf<string>();

/**
 * The union a consumer's `switch` is exhaustive against, `unknown` included.
 *
 * A consumer handling the three real states and not `unknown` compiles today
 * and breaks the first time the provider reports a state added after that
 * consumer's pinned version — which is exactly what spec §2.5 requires the
 * member for. Adding a state here is a change every consumer sees in this type.
 */
expectTypeOf<InvoicePaymentState>()
  .toEqualTypeOf<'awaiting_payment' | 'paid' | 'cancelled' | 'unknown'>();

/**
 * `paymentState` is the narrow union rather than `string`.
 *
 * This is what `Type.Unsafe` buys and a bare `Type.String({ enum })` does not:
 * the same JSON, and no union at all for the consumer. Nothing in
 * `invoice.test.ts` can tell the two apart, because they emit identically.
 *
 * `dueOn` is a `string`, never a `Date` — the consumer-side half of the
 * calendar-day decision `packages/db` pins on the column.
 */
expectTypeOf<Invoice>().toEqualTypeOf<{
  id: string;
  dueOn: string;
  total: { minorUnits: number; currency: string };
  paymentState: InvoicePaymentState;
}>();
