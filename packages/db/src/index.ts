/**
 * Public surface of `@marcos-corp/db`.
 *
 * Owned by the service teams. Nothing under `packages/contracts-*` may import
 * this module — spec §2.1, enforced by `assertNoDbImport` in
 * `@marcos-corp/contract-tooling`, and deliberately including `import type`:
 * a contract that publishes a row type has published the database schema
 * whether or not any JavaScript is emitted.
 *
 * The generated migrations land in a later task and are re-exported from here.
 */

export {
  apiUsage,
  type ApiUsageEvent,
  type NewApiUsageEvent,
} from './schema/apiUsage';
export {
  cardLifecycleStatus,
  cards,
  type Card,
  type CardLifecycleStatus,
  type NewCard,
} from './schema/cards';
export { companies, type Company, type NewCompany } from './schema/companies';
export {
  invoicePaymentState,
  invoices,
  type Invoice,
  type InvoicePaymentState,
  type NewInvoice,
} from './schema/invoices';
export {
  spendLimitResetPeriod,
  spendLimits,
  type NewSpendLimit,
  type SpendLimit,
  type SpendLimitResetPeriod,
} from './schema/spendLimits';
export {
  transactionSettlementState,
  transactions,
  type NewTransaction,
  type Transaction,
  type TransactionSettlementState,
} from './schema/transactions';
