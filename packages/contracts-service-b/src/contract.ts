/**
 * The ts-rest contract `service-b` publishes: one operation over the schemas in
 * `./schemas`, and the one artifact a consumer, the provider and the mock
 * server all read the same API from.
 *
 * ## Why this contract exists at all
 *
 * `service-b` is required by spec §1, and this file is the reason: it proves
 * that today's provider is tomorrow's consumer. `service-b` **publishes** this
 * contract while **pinning** `@marcos-corp/contracts-service-a` at an exact
 * version to resolve company context, so the same team reviews an incoming
 * contract change on one side and authors one on the other. Nothing about
 * governing this package differs from governing `contracts-service-a` — same
 * house ruleset, same four gates, same CODEOWNERS review — which is the claim
 * spec §9.5 asks to be demonstrable.
 *
 * One operation is enough for that claim and is therefore all this package
 * publishes. A second would be more contract, not more evidence.
 *
 * ## `contractSchema` is the load-bearing line in this file
 *
 * ts-rest v3 types every schema slot as `ContractAnyType`: a zod schema, the
 * opaque marker `c.type<T>()` returns, or `null`. A TypeBox schema is none of
 * the three, so passing one straight through is a `check-types` failure whose
 * message names 46 missing zod members and points nowhere useful.
 *
 * The documented escape hatch is `c.type<T>()`, and it is the wrong one: at
 * runtime it is `Symbol(ContractPlainType)` with no schema behind it, so the
 * emitted document would state nothing for that payload. Gate 1 refuses it with
 * reason `compile-time-type`, which makes it a caught mistake rather than a
 * usable option.
 *
 * `contractSchema` below is the pairing that works: ts-rest sees
 * `ContractPlainType<Static<Schema>>`, so `ClientInferResponseBody` and
 * `ServerInferRequest` resolve to the real payload types, while the runtime
 * value is the TypeBox schema `emitOpenApi` walks and publishes. One cast, in
 * one place, with both halves asserted — `contract.test.ts` pins the runtime
 * identity and `contract.test-d.ts` pins the inferred types, and neither suite
 * can make the other's claim.
 *
 * It is a six-line copy of the helper in `contracts-service-a` rather than a
 * shared import, for the reason `./schemas/shared` gives at length: two
 * independently versioned published surfaces that depend on each other version
 * together, and that is precisely the coupling this PoC exists to avoid.
 *
 * ## Why this is `satisfies AppRouter` and not `initContract().router()`
 *
 * `c.router()` is ts-rest's documented entry point and is unusable here, for a
 * reason that has nothing to do with TypeBox. Under zod 4 — which this monorepo
 * pins through a root override, and which ts-rest v3 was never typed against —
 * `c.router()` returns a route type carrying an `[x: string]: any` index
 * signature, so `typeof contract.<route>` no longer satisfies `AppRoute` and
 * every ts-rest inference helper silently falls through to its router branch:
 * `ClientInferResponseBody` yields `any` and `ServerInferRequest` yields
 * `{ [x: string]: any; method: never; body: never }`. A consumer pinning this
 * package would get no types at all, and every type-level assertion about them
 * would pass vacuously.
 *
 * A plain object closed with `satisfies AppRouter` sidesteps it entirely and
 * keeps full inference through `initClient` and through `@ts-rest/express`'s
 * `initServer()`. It also means this module imports nothing from
 * `@ts-rest/core` at runtime, so the package needs no zod of its own.
 *
 * ## Where the credentials are, and why they are not a parameter here
 *
 * Spec §2.3 requires every request to carry a `client_id` derived from
 * credentials. Derived is the operative word: the consumer presents a
 * credential and the provider resolves it, because a `client_id` the caller
 * declares for itself is worth exactly as much as a `User-Agent`.
 *
 * So no route below declares an `Authorization` header. That is not an omission
 * — OpenAPI states that a header parameter named `Authorization`, `Accept` or
 * `Content-Type` SHALL be ignored, so declaring one would publish a requirement
 * no tool reads. The credential belongs in the emitted document's
 * `securitySchemes`, which this package's emit metadata supplies, and what the
 * contract states about it is the `401` the operation carries.
 *
 * ## The error responses
 *
 * Every one of them is the shared `ErrorResponse`, whose `$id` is the literal
 * `Error` house rule 5 requires each `4xx` and `5xx` response to reference.
 * `401` and `500` are properties of every request rather than of any one
 * operation and are spread in from `UNIVERSAL_FAILURES`; the route then adds
 * only the failures that are its own — `400` because it takes a path parameter
 * a consumer can get wrong, and `404` because it addresses a company that may
 * not exist.
 *
 * There is no `403`: the catalogue in `./schemas/error` folds "not yours to
 * see" onto `not_found`, because distinguishing them tells an unauthorised
 * caller which identifiers are real. There is no `502` or `503` either, and
 * that omission is the interesting one — `service-b` resolves company context
 * through `service-a`, so it has an upstream that can be down. Publishing a
 * status for it would put this provider's own dependency graph in its consumers'
 * contract, and the consumer's response would be the same retry that
 * `internal_error` already asks for. Which services `service-b` calls is a
 * deployment fact, not an API promise.
 */
import type { Static, TSchema } from '@sinclair/typebox';
import type { AppRouter, ContractPlainType } from '@ts-rest/core';

import { Type } from '@sinclair/typebox';

import { ErrorResponse } from './schemas/error';
import { Invoice } from './schemas/invoice';
import { CompanyId, requestObject, responseObject } from './schemas/shared';

/**
 * Hands a TypeBox schema to ts-rest without losing either half of it.
 *
 * The cast is deliberate and is the only one in this package. See the header
 * for why the alternatives — passing the schema straight through, or reaching
 * for `c.type<T>()` — fail in opposite directions: the first does not compile,
 * the second compiles and publishes nothing.
 *
 * `ContractPlainType<T>` is ts-rest's marker for "a payload of type T that is
 * not a zod schema", and `ZodInferOrType` unwraps it back to `T`. Declaring the
 * return type as `ContractPlainType<Static<Schema>>` is therefore what makes a
 * consumer's inferred body type the schema's own static type rather than
 * `unknown`.
 */
function contractSchema<Schema extends TSchema>(
  schema: Schema,
): ContractPlainType<Static<Schema>> {
  return schema as unknown as ContractPlainType<Static<Schema>>;
}

/**
 * The two failures no operation can rule out, spread into every route below.
 *
 * `401` is the spec §2.3 identity check failing, which happens before any
 * operation is reached; `500` is the provider failing, which no request can
 * prevent. Declaring them per route by hand would be copies of a fact that
 * belongs to the contract, and a place for the next operation to forget one.
 */
const UNIVERSAL_FAILURES = {
  401: contractSchema(ErrorResponse),
  500: contractSchema(ErrorResponse),
};

/**
 * What a company owes right now: the invoice behind the banner, or nothing.
 *
 * ## Why an envelope with an optional field, and not a bare `Invoice`
 *
 * A company with nothing outstanding is the ordinary case, not a failure. The
 * two alternatives both lose something this one keeps:
 *
 * - **`404` when nothing is due** overloads a status that already means "no
 *   such company, or not yours to see". The consumer could no longer tell "this
 *   company owes nothing" from "you asked about a company you cannot see", and
 *   the second is a bug worth surfacing while the first is a screen without a
 *   banner. Folding them together is exactly the mistake the catalogue avoids
 *   elsewhere by keeping `not_found` for things that are genuinely absent.
 * - **`204 No Content`** gives the consumer two success shapes to branch on for
 *   one question, and leaves nowhere to add a field later without inventing a
 *   third.
 *
 * So `invoice` is optional, and absent means nothing is owed — the same
 * absent-not-null convention every other optional field in this repo follows
 * (spec §2.5, with house rule 6 rejecting `null` outright). One status, one
 * shape, one check.
 *
 * Carries an `$id` because it is what the operation returns: the name a
 * consumer's generated client binds to and the one the diff gate reports
 * changes against.
 */
export const DueInvoice = responseObject({
  invoice: Type.Optional(Invoice),
}, {
  $id: 'DueInvoice',
  description:
    'The invoice a company still owes. Absent when it owes nothing.',
});
export type DueInvoice = Static<typeof DueInvoice>;

/**
 * The published contract.
 *
 * The router key is the `operationId` — `emitOpenApi` derives one from the keys
 * that reach a route rather than reading a declared field, so house rule 5's
 * "operationId present" is structural instead of a convention someone has to
 * remember, and the id a contract author reads here is the one `api_usage`
 * records under spec §2.3. Flat for that reason: a nested `{ companies: { … } }`
 * would publish a worse name than the key already spells.
 */
export const contract = {
  /**
   * The `Invoice due >` banner at the top of the mobile view: the invoice this
   * company still owes, or nothing.
   *
   * A second call rather than a field on `service-a`'s dashboard, because
   * invoices are another team's to serve and one provider fanning out to
   * another makes every `service-b` outage a `service-a` outage. The ownership
   * graph in spec §1 is what makes the extra round trip worth it.
   *
   * `GET /companies/:companyId/due-invoice` names one resource rather than
   * selecting from a collection. `/invoices/due` would read better right up
   * until an `/invoices/:invoiceId` operation lands beside it, at which point
   * `due` is a path segment competing with every real identifier.
   *
   * The company is in the path because that is the axis every authorisation
   * decision here runs along: `service-b` resolves the company through its
   * pinned `contracts-service-a` client before it answers, so a caller that may
   * not act for the company gets the same `404` an unknown one gets.
   */
  getCompanyDueInvoice: {
    method: 'GET',
    path: '/companies/:companyId/due-invoice',
    pathParams: contractSchema(requestObject({ companyId: CompanyId })),
    summary: 'Read the invoice a company still owes, if it owes one.',
    description:
      'Backs the `Invoice due` banner. An absent `invoice` means the company '
      + 'owes nothing, which is an ordinary answer rather than a failure.',
    responses: {
      200: contractSchema(DueInvoice),
      400: contractSchema(ErrorResponse),
      404: contractSchema(ErrorResponse),
      ...UNIVERSAL_FAILURES,
    },
  },
} satisfies AppRouter;
