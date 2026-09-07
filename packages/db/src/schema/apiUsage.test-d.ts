import type { ApiUsageEvent, NewApiUsageEvent } from './apiUsage';

import { expectTypeOf } from 'vitest';

/**
 * Type-level cases for the `api_usage` row types. See the header of
 * `companies.test-d.ts` for why these live in a `.test-d.ts` and which gate
 * reads them: `bun run check-types`, not `bun run test`.
 *
 * This file carries the same weight `invoices.test-d.ts` does, for the same
 * reason. `id` is a `bigserial`, and drizzle renders that identically under
 * `mode: 'number'` and `mode: 'bigint'` — so `apiUsage.test.ts` cannot tell the
 * two apart, and the cases below are the only thing in the four-gate
 * verification order that fails when the mode changes.
 */

/**
 * Every column is `NOT NULL`, so nothing here is nullable — including
 * `occurred_at`, which the service always sets because the column has no
 * database default.
 *
 * `clientId`, `operationId` and `contractVersion` are plain `string`s rather
 * than unions. Deliberate: a `client_id` is issued out of band (spec §6.3), an
 * `operationId` belongs to whichever contract version served the request, and a
 * pinned version is whatever the consumer pinned. Narrowing any of them to a
 * literal union would make this table refuse to record a consumer or an
 * operation the schema had not been told about, which is the one thing a
 * telemetry log must never do.
 */
expectTypeOf<ApiUsageEvent>().toEqualTypeOf<{
  id: number;
  occurredAt: Date;
  clientId: string;
  operationId: string;
  contractVersion: string;
  responseStatusCode: number;
  consumerPackageName: string;
}>();

/** `id` is optional on insert and nothing else is — the shadow of `bigserial`. */
expectTypeOf<NewApiUsageEvent>().toEqualTypeOf<{
  id?: number | undefined;
  occurredAt: Date;
  clientId: string;
  operationId: string;
  contractVersion: string;
  responseStatusCode: number;
  consumerPackageName: string;
}>();

/**
 * The `id` reaches TypeScript as a `number`, never a `string`.
 *
 * Pinned separately from the row shape above because this is the assertion that
 * survives a reader skimming: drizzle renders `bigint` and `bigserial` as
 * `string` under `mode: 'bigint'`, and nothing in SQL changes, so the usage
 * logger's arithmetic and every ordering comparison would silently become
 * string operations. Same trap the money columns are pinned against.
 */
expectTypeOf<ApiUsageEvent['id']>().toEqualTypeOf<number>();

/**
 * `occurred_at` is an instant, not a calendar day — the repo convention for a
 * `timestamptz`, and the opposite of `invoices.dueOn`. Both the 30-day window
 * of spec §9.4 and the 13-month retention of spec §6.4 are measured against
 * this field, and a `string` here would make either comparison lexical.
 */
expectTypeOf<ApiUsageEvent['occurredAt']>().toEqualTypeOf<Date>();

/**
 * The HTTP status code is a `number`, so a range test (`>= 400`) is arithmetic.
 * `smallint` is the one integer type in this schema that is not minor units,
 * and it reaches TypeScript the same way the money columns do.
 */
expectTypeOf<ApiUsageEvent['responseStatusCode']>().toEqualTypeOf<number>();
