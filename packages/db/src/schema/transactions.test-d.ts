import type { NewTransaction, Transaction, TransactionSettlementState } from './transactions';

import { expectTypeOf } from 'vitest';

/**
 * Type-level cases for the `transactions` row types. See the header of
 * `companies.test-d.ts` for why these live in a `.test-d.ts` and which gate
 * reads them: `bun run check-types`, not `bun run test`.
 */

/**
 * Every column is `NOT NULL`, so nothing is nullable. Two of these fields are
 * a flat pair the contract publishes as one object — `amountMinorUnits` and
 * `currencyCode` become a single money value in the payload — which is the
 * translation `service-a`'s transaction mapper exists to do.
 */
expectTypeOf<Transaction>().toEqualTypeOf<{
  id: string;
  cardId: string;
  companyId: string;
  bookedAt: Date;
  amountMinorUnits: number;
  currencyCode: string;
  merchantName: string;
  merchantCategoryCode: string;
  settlementState: 'authorised' | 'settled' | 'reversed' | 'disputed';
}>();

/** `id` is optional on insert and nothing else is — the shadow of `.defaultRandom()`. */
expectTypeOf<NewTransaction>().toEqualTypeOf<{
  id?: string | undefined;
  cardId: string;
  companyId: string;
  bookedAt: Date;
  amountMinorUnits: number;
  currencyCode: string;
  merchantName: string;
  merchantCategoryCode: string;
  settlementState: 'authorised' | 'settled' | 'reversed' | 'disputed';
}>();

/**
 * The union the transaction mapper switches over, stated separately because it
 * is the type `service-a` imports by name. No `unknown` member — that is the
 * contract enum's, and folding an unrecognised value onto it is the mapper's
 * job rather than the schema's.
 */
expectTypeOf<TransactionSettlementState>()
  .toEqualTypeOf<'authorised' | 'settled' | 'reversed' | 'disputed'>();

/**
 * `merchantCategoryCode` is a plain `string`, deliberately not a union.
 *
 * ISO-18245 MCCs are an open set the card networks extend without asking, so
 * the provider cannot enumerate them. That is the concrete reason the
 * contract's merchant-category enum needs an explicit `unknown` member (spec
 * §2.5): a code the mapper has never seen must degrade to `unknown` rather than
 * fail a response. A union here would claim a closed set and make every new MCC
 * a schema change.
 */
expectTypeOf<Transaction['merchantCategoryCode']>().toEqualTypeOf<string>();

/** Integer minor units reach TypeScript as a `number`, never a `string`. See `spendLimits.test-d.ts`. */
expectTypeOf<Transaction['amountMinorUnits']>().toEqualTypeOf<number>();
