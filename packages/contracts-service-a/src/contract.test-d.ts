import type { ActivateCardRequest, CompanyList, TransactionList } from './contract';
import type { Card } from './schemas/card';
import type { Dashboard } from './schemas/dashboard';
import type { ErrorResponse } from './schemas/error';
import type { PageInfo } from './schemas/shared';
import type { ClientInferResponseBody, ServerInferRequest } from '@ts-rest/core';

import { expectTypeOf } from 'vitest';

import { contract } from './contract';

/**
 * Type-level cases for the contract. Read by `bun run check-types`, not by
 * `bun run test` — see the header of `shared.test-d.ts` for the split.
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
 * The four success payloads a consumer binds to.
 *
 * `ClientInferResponseBody` is the type a ts-rest client hands back for a given
 * status, so these are literally what `apps/web-a`, `apps/web-b` and
 * `services/service-b` will be holding.
 */
expectTypeOf<ClientInferResponseBody<typeof contract.listCompanies, 200>>()
  .toEqualTypeOf<CompanyList>();
expectTypeOf<ClientInferResponseBody<typeof contract.getCompanyDashboard, 200>>()
  .toEqualTypeOf<Dashboard>();
expectTypeOf<ClientInferResponseBody<typeof contract.listCompanyTransactions, 200>>()
  .toEqualTypeOf<TransactionList>();
expectTypeOf<ClientInferResponseBody<typeof contract.activateCard, 200>>()
  .toEqualTypeOf<Card>();

/**
 * Every failure is the one shared payload, so a consumer writes one error path
 * and reuses it across the contract. Checked on the two statuses that come from
 * `commonResponses` and on two a single operation adds, because the merge is
 * what puts the first pair there and a merge that dropped the type would still
 * leave the status present.
 */
expectTypeOf<ClientInferResponseBody<typeof contract.listCompanies, 401>>()
  .toEqualTypeOf<ErrorResponse>();
expectTypeOf<ClientInferResponseBody<typeof contract.getCompanyDashboard, 500>>()
  .toEqualTypeOf<ErrorResponse>();
expectTypeOf<ClientInferResponseBody<typeof contract.listCompanyTransactions, 404>>()
  .toEqualTypeOf<ErrorResponse>();
expectTypeOf<ClientInferResponseBody<typeof contract.activateCard, 409>>()
  .toEqualTypeOf<ErrorResponse>();

/**
 * The list envelopes are the shared `{ items, page }` over their own item type.
 * A consumer reads `page.total` to render the `N more items` count, which is
 * the whole reason a bare array was not published.
 */
expectTypeOf<CompanyList>().toEqualTypeOf<{
  items: { id: string; name: string }[];
  page: PageInfo;
}>();
expectTypeOf<TransactionList['page']>().toEqualTypeOf<PageInfo>();

/**
 * The activation request, as the provider receives it.
 *
 * `ServerInferRequest` is what `services/service-a`'s route implementation will
 * bind its handler argument to, so this is the same type on both sides of the
 * wire — the property a shared contract package exists to have.
 */
expectTypeOf<ServerInferRequest<typeof contract.activateCard>['body']>()
  .toEqualTypeOf<ActivateCardRequest>();
// Spelled out as well as compared, because the case above compares a derived
// type against the type it is derived from: renaming the field in the schema
// renames it on both sides and the comparison stays green. This one does not.
expectTypeOf<ActivateCardRequest>().toEqualTypeOf<{ confirmedLastFour: string }>();
expectTypeOf<ServerInferRequest<typeof contract.activateCard>['params']>()
  .toEqualTypeOf<{ companyId: string; cardId: string }>();

/**
 * The path parameters of the two company-scoped reads, and the absence of any
 * on the one operation that addresses nothing.
 *
 * The absence case is the inverting half: every case above states that a
 * declared parameter reaches the type, and none of them would notice a
 * parameter appearing on `listCompanies`.
 */
expectTypeOf<ServerInferRequest<typeof contract.getCompanyDashboard>['params']>()
  .toEqualTypeOf<{ companyId: string }>();
expectTypeOf<ServerInferRequest<typeof contract.listCompanyTransactions>['params']>()
  .toEqualTypeOf<{ companyId: string }>();
expectTypeOf<ServerInferRequest<typeof contract.listCompanies>>().not.toHaveProperty('params');

/**
 * Both paginated reads take the same optional query pair, so a consumer that
 * omits them gets the documented defaults rather than a rejection.
 */
expectTypeOf<ServerInferRequest<typeof contract.listCompanies>['query']>()
  .toEqualTypeOf<{ limit?: number; offset?: number }>();
expectTypeOf<ServerInferRequest<typeof contract.listCompanyTransactions>['query']>()
  .toEqualTypeOf<{ limit?: number; offset?: number }>();
