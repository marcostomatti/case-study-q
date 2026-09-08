/**
 * The ts-rest contract `service-a` publishes: four operations over the schemas
 * in `./schemas`, and the one artifact a consumer, the provider and the mock
 * server all read the same API from.
 *
 * The operations are the mobile view in `assets/mobile-view.png`, taken apart
 * along the only seam that matters here — what a consumer asks for in one go.
 * The dashboard is one call because the screen is one view; the transaction
 * list is a second because `54 more items in transaction view` is a second
 * screen; activating the card is a third because it is a state change. Listing
 * companies is what the selector at the top needs before any of the others can
 * be addressed.
 *
 * ## `contractSchema` is the load-bearing line in this file
 *
 * ts-rest v3 types every schema slot as `ContractAnyType`, which is a zod
 * schema, the opaque marker `c.type<T>()` returns, or `null`. A TypeBox schema
 * is none of the three, so passing one straight through is a `check-types`
 * failure — measured, and the message names 46 missing zod members rather than
 * anything a reader would connect to this decision.
 *
 * The documented escape hatch is `c.type<T>()`, and it is the wrong one: at
 * runtime it is `Symbol(ContractPlainType)` with no schema behind it, so the
 * emitted document would state nothing for that payload. Gate 1 refuses it
 * with reason `compile-time-type`, which makes it a caught mistake rather than
 * a usable option.
 *
 * `contractSchema` below is the pairing that works. ts-rest sees
 * `ContractPlainType<Static<Schema>>`, so `ClientInferResponseBody` and
 * `ServerInferRequest` resolve to the real payload types for every consumer;
 * the value at runtime is the TypeBox schema itself, which is what
 * `emitOpenApi` walks and publishes. One cast, in one place, with both halves
 * asserted — `contract.test.ts` pins the runtime identity, `contract.test-d.ts`
 * pins the inferred types, and neither suite can make the other's claim.
 *
 * ## Why this is `satisfies AppRouter` and not `initContract().router()`
 *
 * `c.router()` is ts-rest's documented entry point and it is unusable here,
 * for a reason that has nothing to do with TypeBox. Under zod 4 — which this
 * monorepo pins through a root override — `c.router()` returns a route type
 * carrying an `[x: string]: any` index signature, so `typeof contract.<route>`
 * no longer satisfies `AppRoute` and every ts-rest inference helper silently
 * falls through to its router branch. `ServerInferRequest` yields
 * `{ [x: string]: any; method: never; body: never }` and
 * `ClientInferResponseBody` yields `any`: a consumer pinning this package gets
 * no types at all, and every type-level assertion about it passes vacuously.
 *
 * Measured, with controls, on `@ts-rest/core@3.52.1` and TypeScript 5.9.3 —
 * the same contract under zod 3.25.76 infers correctly through `c.router()`,
 * and both a zod-authored and a `c.type()`-authored contract degrade under
 * zod 4.5.1. It is a version mismatch against ts-rest v3's declared
 * `zod: ^3.22.3` peer, not anything about this contract.
 *
 * A plain object with `satisfies AppRouter` sidesteps it entirely, and was
 * verified to carry full types through `initClient` and through
 * `@ts-rest/express`'s `initServer().router()` under zod 4. What it costs is
 * `c.router()`'s `commonResponses` option, replaced below by an ordinary
 * spread — and what it buys back is that this module imports nothing from
 * `@ts-rest/core` at runtime, so the package needs no zod of its own.
 *
 * ## Where the credentials are, and why they are not a parameter here
 *
 * Spec section 2.3 requires every request to carry a `client_id` derived from
 * credentials. Derived is the operative word: the consumer presents a
 * credential and the provider resolves it, because a `client_id` the caller
 * declares for itself is worth exactly as much as a `User-Agent`.
 *
 * So no route below declares an `Authorization` header. That is not an
 * omission — OpenAPI states that a header parameter named `Authorization`,
 * `Accept` or `Content-Type` SHALL be ignored, so declaring one would publish
 * a requirement no tool reads. The credential belongs in the emitted
 * document's `securitySchemes`, which this package's emit metadata supplies,
 * and what the contract states about it is the `401` every operation carries.
 *
 * ## The error responses
 *
 * Every one of them is the shared `ErrorResponse`, whose `$id` is the literal
 * `Error` house rule 5 requires each `4xx` and `5xx` response to reference.
 * `401` and `500` are properties of every request rather than of any one
 * operation and are spread in from `UNIVERSAL_FAILURES`; each route then adds
 * only the failures that are its own — `400` where it takes input a consumer
 * can get wrong, `404` where it addresses something that may not exist, `409`
 * where the request is well-formed but the thing is in the wrong state.
 *
 * There is no `403`: the error catalogue folds "not yours to see" onto
 * `not_found` on purpose, because distinguishing them tells an unauthorised
 * caller which identifiers are real. There is no `429` either — the catalogue
 * in `./schemas/error` has no code for it, and publishing a status a consumer
 * cannot branch on is worse than not publishing it.
 *
 * ## Both lists are paginated, including the short one
 *
 * A list with no ceiling in the contract is an unbounded query in the
 * provider, and the consumer learns the bound from a rejection rather than
 * from the document. The company selector usually renders one or two rows and
 * the transaction view renders 57; the same envelope and the same
 * `PaginationQuery` cover both, and `PageInfo.total` is what a consumer counts
 * the rest with.
 */
import type { Static, TSchema } from '@sinclair/typebox';
import type { AppRouter, ContractPlainType } from '@ts-rest/core';

import { Type } from '@sinclair/typebox';

import { Card, CardId } from './schemas/card';
import { CompanyId, CompanySummary } from './schemas/company';
import { Dashboard } from './schemas/dashboard';
import { ErrorResponse } from './schemas/error';
import {
  paginatedResponse,
  PaginationQuery,
  requestObject,
} from './schemas/shared';
import { Transaction } from './schemas/transaction';

/**
 * Hands a TypeBox schema to ts-rest without losing either half of it.
 *
 * The cast is deliberate and is the only one in this package. See the header
 * for why the alternatives — passing the schema straight through, or reaching
 * for `c.type<T>()` — fail in opposite directions: the first does not compile,
 * the second compiles and publishes nothing.
 *
 * `ContractPlainType<T>` is ts-rest's marker for "a payload of type T that is
 * not a zod schema", and `ZodInferOrType` unwraps it back to `T`. Declaring
 * the return type as `ContractPlainType<Static<Schema>>` is therefore what
 * makes a consumer's inferred body type the schema's own static type rather
 * than `unknown`.
 */
function contractSchema<Schema extends TSchema>(
  schema: Schema,
): ContractPlainType<Static<Schema>> {
  return schema as unknown as ContractPlainType<Static<Schema>>;
}

/** A masked PAN suffix is exactly four digits — both bounds and the pattern. */
const LAST_FOUR_LENGTH = 4;

/** Digits only. A pattern alone is easy to widen; the lengths pin it. */
const LAST_FOUR_PATTERN = '^[0-9]{4}$';

/**
 * The two failures no operation can rule out, spread into every route below.
 *
 * `401` is the spec section 2.3 identity check failing, which happens before
 * any operation is reached; `500` is the provider failing, which no request
 * can prevent. Declaring them per route by hand would be four copies of a fact
 * that belongs to the contract, and four places for the fifth operation to
 * forget one.
 */
const UNIVERSAL_FAILURES = {
  401: contractSchema(ErrorResponse),
  500: contractSchema(ErrorResponse),
};

/**
 * A page of companies, as the selector at the top of the screen lists them.
 *
 * Carries an `$id` because an operation's own response is a shape a consumer's
 * generated client binds to and the diff gate reports changes against — the
 * third case of the `$id` convention `./schemas/shared` sets, alongside
 * "reused across operations" and "inlined scalar".
 */
export const CompanyList = paginatedResponse(CompanySummary, {
  $id: 'CompanyList',
  description: 'A page of the companies the caller may act for.',
});
export type CompanyList = Static<typeof CompanyList>;

/**
 * A page of one company's transactions, newest first.
 *
 * The same envelope as `CompanyList` over a different item type, which is what
 * `paginatedResponse` exists for: JSON Schema has no generics, so each list is
 * its own component and the shared part is the builder rather than the shape.
 */
export const TransactionList = paginatedResponse(Transaction, {
  $id: 'TransactionList',
  description: 'A page of one company\'s transactions, newest first.',
});
export type TransactionList = Static<typeof TransactionList>;

/**
 * What a cardholder sends to activate the card that arrived in the post.
 *
 * `confirmedLastFour` is a possession check and nothing more: the caller is
 * already authenticated for the company, and this is the cardholder reading
 * four digits off a piece of plastic they are holding. It is not an
 * authorisation decision — `activateCard` is the authority on whether an
 * activation succeeds, and answers `409` when the card is not activatable.
 *
 * The bounds repeat `Card.lastFour`'s, and deliberately state their own copy
 * rather than sharing a component with it. A request constraint and a response
 * constraint are separately versioned: loosening what the provider will accept
 * must not silently loosen what it promises to return, and one schema serving
 * both is how that happens. The same argument `./schemas/company` makes for
 * stating each identifier's bound separately. `contract.test.ts` asserts the
 * two agree, so a drift between them fails rather than ships.
 *
 * Being built by `requestObject`, it rejects unknown fields — the strict half
 * of spec section 2.5, and the only request body in this contract, so it is
 * where that half is demonstrable at all.
 */
export const ActivateCardRequest = requestObject({
  confirmedLastFour: Type.String({
    description:
      'The last four digits printed on the physical card, as the cardholder '
      + 'reads them off it.',
    pattern: LAST_FOUR_PATTERN,
    minLength: LAST_FOUR_LENGTH,
    maxLength: LAST_FOUR_LENGTH,
    examples: ['4321'],
  }),
}, {
  $id: 'ActivateCardRequest',
  description: 'Confirmation that the cardholder is holding the card.',
});
export type ActivateCardRequest = Static<typeof ActivateCardRequest>;

/**
 * The published contract.
 *
 * Every router key is an `operationId` — `emitOpenApi` derives one from the
 * keys that reach a route rather than reading a declared field, so house rule
 * 5's "operationId present" is structural instead of a convention someone has
 * to remember, and the id a contract author reads here is the one `api_usage`
 * records under spec section 2.3. The router is flat for that reason: a nested
 * `{ companies: { list } }` would publish `companiesList`, which is a worse
 * name than the one the key already spells.
 */
export const contract = {
  /**
   * Every company the caller may act for. What the selector at the top of the
   * mobile view renders, and what scopes every other operation here.
   */
  listCompanies: {
    method: 'GET',
    path: '/companies',
    query: contractSchema(PaginationQuery),
    summary: 'List the companies the caller may act for.',
    description:
      'Backs the company selector. Every other operation in this contract is '
      + 'scoped by one of the identifiers returned here.',
    responses: {
      200: contractSchema(CompanyList),
      400: contractSchema(ErrorResponse),
      ...UNIVERSAL_FAILURES,
    },
  },

  /**
   * The whole mobile view in one response: the selected company, its card, the
   * remaining-spend meter, the three latest transactions and the count behind
   * `54 more items`.
   *
   * One call rather than five, because the screen is one view opened once on a
   * phone. Two of the fields could not be assembled client-side at any cost —
   * `spend.remaining` is not stored anywhere, and `furtherTransactionCount`
   * counts rows the consumer never receives. See `./schemas/dashboard`.
   */
  getCompanyDashboard: {
    method: 'GET',
    path: '/companies/:companyId/dashboard',
    pathParams: contractSchema(requestObject({ companyId: CompanyId })),
    summary: 'Read everything the mobile view renders for one company.',
    description:
      'Aggregated on the provider side because the screen is one view and two '
      + 'of its figures are derived rather than stored.',
    responses: {
      200: contractSchema(Dashboard),
      400: contractSchema(ErrorResponse),
      404: contractSchema(ErrorResponse),
      ...UNIVERSAL_FAILURES,
    },
  },

  /**
   * The transaction view behind `54 more items`, a page at a time.
   *
   * Ordered newest first, which is the order the dashboard's three come in and
   * the only order this screen reads them in. Stated in the response schema's
   * description rather than as a `sort` parameter: a parameter would publish
   * an ordering the provider then owes forever, for a screen that offers no
   * way to change it.
   */
  listCompanyTransactions: {
    method: 'GET',
    path: '/companies/:companyId/transactions',
    pathParams: contractSchema(requestObject({ companyId: CompanyId })),
    query: contractSchema(PaginationQuery),
    summary: 'List one company\'s transactions, newest first.',
    description:
      'The paginated view behind the dashboard\'s `N more items` link. '
      + '`page.total` is what that count is derived from.',
    responses: {
      200: contractSchema(TransactionList),
      400: contractSchema(ErrorResponse),
      404: contractSchema(ErrorResponse),
      ...UNIVERSAL_FAILURES,
    },
  },

  /**
   * Activate a card the cardholder is holding. The `Activate card` action at
   * the bottom of the mobile view.
   *
   * `POST` to an `activation` sub-resource rather than to a `/activate` verb:
   * the state transition is a thing that gets created, which is what a URL can
   * name, and a verb in a path is a remote procedure call wearing REST's
   * clothes. It answers `200` with the updated card rather than `201` with the
   * activation, because the card is what the consumer re-renders and the
   * activation record is the provider's.
   *
   * Not idempotent, and it says so with `409`: a second activation of an
   * already-active card is a conflict rather than a silent success, so a
   * double-tap is reported instead of being indistinguishable from the first.
   *
   * The path carries the company as well as the card. `Card` publishes no
   * `companyId` — it is reached through a company the caller already selected —
   * so the scope has to be in the URL, and putting it there keeps the
   * authorisation check on the same axis as every other operation here.
   */
  activateCard: {
    method: 'POST',
    path: '/companies/:companyId/cards/:cardId/activation',
    pathParams: contractSchema(requestObject({
      companyId: CompanyId,
      cardId: CardId,
    })),
    body: contractSchema(ActivateCardRequest),
    summary: 'Activate a card the cardholder is holding.',
    description:
      'Answers with the updated card. A card that is not activatable is a '
      + '`409` rather than a silent success.',
    responses: {
      200: contractSchema(Card),
      400: contractSchema(ErrorResponse),
      404: contractSchema(ErrorResponse),
      409: contractSchema(ErrorResponse),
      ...UNIVERSAL_FAILURES,
    },
  },
} satisfies AppRouter;
