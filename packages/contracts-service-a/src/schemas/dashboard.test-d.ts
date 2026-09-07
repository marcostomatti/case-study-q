import type { Card } from './card';
import type { CompanySummary } from './company';
import type { Dashboard, SpendSummary } from './dashboard';
import type { MonetaryAmount } from './shared';
import type { Transaction } from './transaction';

import { expectTypeOf } from 'vitest';

/**
 * Type-level cases for the aggregated dashboard payload. Read by
 * `bun run check-types`, not by `bun run test` — see the header of
 * `shared.test-d.ts` for the split.
 */

/**
 * The meter is two amounts, and both are the shared money type.
 *
 * A bespoke `{ currency, remainingMinorUnits, limitMinorUnits }` would be a
 * second money shape in a contract whose whole money convention is one
 * component. That the two share a currency is an invariant the provider holds,
 * not one this type states.
 */
expectTypeOf<SpendSummary>().toEqualTypeOf<{
  remaining: MonetaryAmount;
  limit: MonetaryAmount;
}>();

/**
 * The payload a consumer binds to, with every member required.
 *
 * The three shapes it shares with other operations are the same types those
 * operations publish, not structural copies: a consumer that renders a card on
 * the dashboard and after an activation is holding one type in both places.
 *
 * `furtherTransactionCount` is a `number` and not a branded count — the bound
 * lives in the JSON, which `dashboard.test.ts` owns.
 */
expectTypeOf<Dashboard>().toEqualTypeOf<{
  company: CompanySummary;
  card: Card;
  spend: SpendSummary;
  latestTransactions: Transaction[];
  furtherTransactionCount: number;
}>();

/**
 * Nothing is optional. An optional member added here would compile at every
 * consumer while changing what the screen can rely on — the change spec §6.1
 * wants cheap and spec §6.2 wants visible.
 */
expectTypeOf<Required<Dashboard>>().toEqualTypeOf<Dashboard>();
