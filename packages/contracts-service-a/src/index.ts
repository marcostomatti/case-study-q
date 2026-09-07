/**
 * Public surface of `@marcos-corp/contracts-service-a`.
 *
 * What has landed so far: the TypeBox primitives every operation reuses
 * (`./schemas/shared`), the shared error payload every error response
 * references (`./schemas/error`), the company the selector lists
 * (`./schemas/company`), the card the screen renders (`./schemas/card`), a
 * transaction row (`./schemas/transaction`) and the aggregated dashboard
 * payload (`./schemas/dashboard`). The ts-rest contract that exposes them lands
 * in a later task and is re-exported here when it does.
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
 */

export {
  CARD_STATES,
  Card,
  CardId,
  CardState,
} from './schemas/card';
export {
  CompanyId,
  CompanySummary,
} from './schemas/company';
export {
  DASHBOARD_TRANSACTION_COUNT,
  Dashboard,
  SpendSummary,
} from './schemas/dashboard';
export {
  ERROR_CODES,
  ERROR_SCHEMA_ID,
  ErrorCode,
  ErrorResponse,
} from './schemas/error';
export {
  type ContractObjectOptions,
  CurrencyCode,
  MonetaryAmount,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  PAGE_LIMIT_MIN,
  PageInfo,
  PaginationQuery,
  paginatedResponse,
  requestObject,
  responseObject,
  Timestamp,
} from './schemas/shared';
export {
  MERCHANT_CATEGORIES,
  MerchantCategory,
  TRANSACTION_SETTLEMENT_STATES,
  Transaction,
  TransactionId,
  TransactionSettlementState,
} from './schemas/transaction';
