import type { DueInvoice } from './contract';
import type { ErrorResponse } from './schemas/error';
import type { Invoice } from './schemas/invoice';
import type { ClientInferResponseBody, ServerInferRequest } from '@ts-rest/core';

import { expectTypeOf } from 'vitest';

import { contract } from './contract';

/**
 * Type-level cases for the contract. Read by `bun run check-types`, not by
 * `bun run test` — see the header of `schemas/shared.test-d.ts` for the split.
 *
 * Everything here is a claim about `contractSchema` in `./contract`, and it is
 * the half `contract.test.ts` structurally cannot make. That helper exists to
 * keep two things true at once: the runtime value is the TypeBox schema, and
 * the type ts-rest infers for a consumer is the schema's own static type.
 *
 * Written the plausible wrong ways, each of which the runtime suite passes
 * unchanged:
 *
 * - `schema as unknown as ContractPlainType<unknown>` — every body below
 *   becomes `unknown`, and a consumer gets no type at all from the contract it
 *   pinned.
 * - `schema as never` — the same failure, reported at the route rather than at
 *   the consumer.
 *
 * Neither is visible in the emitted document, in the house rules or in the diff
 * gate: they are a property of the TypeScript surface this package publishes,
 * and this file is the only gate in the verification order that reads it.
 */

/**
 * The success payload a consumer binds to.
 *
 * `ClientInferResponseBody` is the type a ts-rest client hands back for a given
 * status, so this is literally what a consumer of `service-b` will be holding.
 */
expectTypeOf<ClientInferResponseBody<typeof contract.getCompanyDueInvoice, 200>>()
  .toEqualTypeOf<DueInvoice>();

/**
 * Spelled out as well as compared, because the case above compares a derived
 * type against the type it is derived from: renaming the field in the schema
 * renames both sides and the comparison stays green.
 *
 * `invoice` is optional and possibly `undefined`, never `null` — absent means
 * the company owes nothing (spec §2.5). That is the whole reason the operation
 * answers `200` with an envelope rather than `404`.
 */
expectTypeOf<DueInvoice>().toEqualTypeOf<{ invoice?: Invoice | undefined }>();

/**
 * Every failure is the one shared payload, so a consumer writes one error path
 * and reuses it. Checked on the two statuses that come from `UNIVERSAL_FAILURES`
 * and on the two the operation adds, because the spread is what puts the first
 * pair there and a spread that dropped the type would still leave the status
 * present.
 */
expectTypeOf<ClientInferResponseBody<typeof contract.getCompanyDueInvoice, 401>>()
  .toEqualTypeOf<ErrorResponse>();
expectTypeOf<ClientInferResponseBody<typeof contract.getCompanyDueInvoice, 500>>()
  .toEqualTypeOf<ErrorResponse>();
expectTypeOf<ClientInferResponseBody<typeof contract.getCompanyDueInvoice, 400>>()
  .toEqualTypeOf<ErrorResponse>();
expectTypeOf<ClientInferResponseBody<typeof contract.getCompanyDueInvoice, 404>>()
  .toEqualTypeOf<ErrorResponse>();

/**
 * The path parameter, as the provider receives it.
 *
 * `ServerInferRequest` is what `services/service-b`'s route implementation will
 * bind its handler argument to, so this is the same type on both sides of the
 * wire — the property a shared contract package exists to have.
 */
expectTypeOf<ServerInferRequest<typeof contract.getCompanyDueInvoice>['params']>()
  .toEqualTypeOf<{ companyId: string }>();

/**
 * The operation takes nothing else. The absence cases are the inverting half:
 * every case above states that a declared slot reaches the type, and none of
 * them would notice a body or a query appearing on a read that has no use for
 * one.
 */
expectTypeOf<ServerInferRequest<typeof contract.getCompanyDueInvoice>>().not.toHaveProperty('body');
expectTypeOf<ServerInferRequest<typeof contract.getCompanyDueInvoice>>().not.toHaveProperty('query');
