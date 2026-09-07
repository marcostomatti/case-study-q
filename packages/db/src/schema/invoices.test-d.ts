import type { Invoice, InvoicePaymentState, NewInvoice } from './invoices';

import { expectTypeOf } from 'vitest';

/**
 * Type-level cases for the `invoices` row types. See the header of
 * `companies.test-d.ts` for why these live in a `.test-d.ts` and which gate
 * reads them: `bun run check-types`, not `bun run test`.
 *
 * This file carries more weight than its siblings. `due_on`'s drizzle `mode` is
 * erased by the time `getSQLType()` sees it — all three modes render `date` —
 * so `invoices.test.ts` cannot tell a `string` due date from a `Date` one, and
 * the case below is the only thing in the four-gate verification order that
 * fails when the mode changes.
 */

/**
 * Every column is `NOT NULL`, so nothing here is nullable.
 *
 * `dueOn` is a `string` and the only temporal field in this schema that is:
 * every other one is a `timestamptz` reaching TypeScript as a `Date`. An
 * invoice falls due on a calendar day, and a `Date` for a calendar day carries
 * a time-of-day nobody chose and renders as the previous day for a reader in
 * another zone. Changing the column to `mode: 'date'`, or widening it to
 * `timestamp`, fails here.
 */
expectTypeOf<Invoice>().toEqualTypeOf<{
  id: string;
  companyId: string;
  dueOn: string;
  totalMinorUnits: number;
  currencyCode: string;
  paymentState: 'draft' | 'issued' | 'paid' | 'written_off';
}>();

/** `id` is optional on insert and nothing else is — the shadow of `.defaultRandom()`. */
expectTypeOf<NewInvoice>().toEqualTypeOf<{
  id?: string | undefined;
  companyId: string;
  dueOn: string;
  totalMinorUnits: number;
  currencyCode: string;
  paymentState: 'draft' | 'issued' | 'paid' | 'written_off';
}>();

/**
 * The union `service-b`'s invoice mapper switches over, stated separately
 * because it is the type that service imports by name and an exhaustive
 * `switch` is only exhaustive against whatever this resolves to. No `unknown`
 * member — that is the contract enum's, and folding an unrecognised value onto
 * it is the mapper's job rather than the schema's. No `overdue` either: that is
 * `dueOn` compared against today, not a stored state.
 */
expectTypeOf<InvoicePaymentState>().toEqualTypeOf<'draft' | 'issued' | 'paid' | 'written_off'>();

/**
 * Integer minor units reach TypeScript as a `number`, never a `string`. Worth
 * pinning per table: drizzle renders `bigint` and `numeric` as `string` by
 * default, so the widening noted in `invoices.ts` — or a well-meant "money
 * should be numeric" change — turns every arithmetic site into string
 * concatenation with nothing else in the gate order noticing.
 */
expectTypeOf<Invoice['totalMinorUnits']>().toEqualTypeOf<number>();
