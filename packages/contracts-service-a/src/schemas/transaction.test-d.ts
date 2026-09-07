import type { MonetaryAmount } from './shared';
import type {
  MerchantCategory,
  Transaction,
  TransactionId,
  TransactionSettlementState,
} from './transaction';

import { expectTypeOf } from 'vitest';

/**
 * Type-level cases for a transaction row. Read by `bun run check-types`, not by
 * `bun run test` — see the header of `shared.test-d.ts` for the split.
 */

/** An identifier is a plain string; its bound lives in the JSON. */
expectTypeOf<TransactionId>().toEqualTypeOf<string>();

/**
 * The unions a consumer's `switch` is exhaustive against, `unknown` included.
 *
 * A consumer handling only the real members compiles today and breaks the first
 * time the provider reports a value added after that consumer's pinned version
 * — which is exactly what spec §2.5 requires the member for. Adding a member
 * here is a change every consumer sees in this type.
 */
expectTypeOf<TransactionSettlementState>().toEqualTypeOf<'pending' | 'completed' | 'reversed' | 'unknown'>();

expectTypeOf<MerchantCategory>().toEqualTypeOf<
  'dining' | 'fuel' | 'groceries' | 'retail' | 'software' | 'telecom' | 'travel' | 'unknown'
>();

/**
 * Both enum fields are the narrow union rather than `string`.
 *
 * This is what `Type.Unsafe` buys and a bare `Type.String({ enum })` does not:
 * the same JSON, and no union at all for the consumer. Nothing in
 * `transaction.test.ts` can tell the two apart, because they emit identically.
 *
 * `amount` is the shared money type rather than a structurally similar copy, so
 * a change to `MonetaryAmount` reaches every consumer of this row.
 */
expectTypeOf<Transaction>().toEqualTypeOf<{
  id: string;
  bookedAt: string;
  merchantName: string;
  merchantCategory: MerchantCategory;
  amount: MonetaryAmount;
  settlementState: TransactionSettlementState;
}>();
