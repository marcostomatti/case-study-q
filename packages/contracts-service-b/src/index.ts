/**
 * Public surface of `@marcos-corp/contracts-service-b`.
 *
 * The contract itself is `./contract`: one operation over the TypeBox
 * primitives it reuses (`./schemas/shared`), the shared error payload every
 * error response references (`./schemas/error`) and the invoice the mobile
 * view's `Invoice due` banner renders (`./schemas/invoice`).
 *
 * A consumer needs `contract` and the types; a provider needs the same
 * `contract` and the schemas to validate against. Both come from here, which is
 * the property that makes the two sides provably the same API rather than two
 * descriptions of one.
 *
 * Consumers import their types from this module rather than from a generator —
 * spec §5's "types for consumers: from the contract package". Each schema is
 * exported once and carries both meanings of its name: the TypeBox value for
 * anything building a contract or validating a payload, and the `Static<>` type
 * for anything binding to one.
 *
 * Two constraints bind everything added to this package:
 *
 * - Schemas are hand-authored in TypeBox and never derived from
 *   `@marcos-corp/db` (spec §2.1). This package must not depend on it, and
 *   `assertNoDbImport` fails the build if it does — `import type` included.
 * - The package `version` is what consumers pin exactly, with no range
 *   specifier (spec §2.2), so a bump here is a reviewable event for every
 *   consumer rather than an implicit upgrade.
 *
 * service-b is the case that proves ownership shifts: it publishes this
 * contract while consuming `@marcos-corp/contracts-service-a`, so the same team
 * authors a contract change on one side and reviews one on the other. Nothing
 * here imports that package — a provider's own published surface must not
 * depend on the surface it happens to consume.
 */

export {
  contract,
  DueInvoice,
} from './contract';
export {
  ERROR_CODES,
  ERROR_SCHEMA_ID,
  ErrorCode,
  ErrorResponse,
} from './schemas/error';
export {
  INVOICE_PAYMENT_STATES,
  Invoice,
  InvoiceId,
  InvoicePaymentState,
} from './schemas/invoice';
export {
  CalendarDate,
  CompanyId,
  type ContractObjectOptions,
  CurrencyCode,
  MonetaryAmount,
  requestObject,
  responseObject,
} from './schemas/shared';
