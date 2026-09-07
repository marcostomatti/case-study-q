/**
 * Public surface of `@marcos-corp/db`.
 *
 * Owned by the service teams. Nothing under `packages/contracts-*` may import
 * this module — spec §2.1, enforced by `assertNoDbImport` in
 * `@marcos-corp/contract-tooling`, and deliberately including `import type`:
 * a contract that publishes a row type has published the database schema
 * whether or not any JavaScript is emitted.
 *
 * The remaining tables (spend limits, transactions, invoices, api_usage) and
 * the generated migrations land in later tasks and are re-exported from here.
 */

export {
  cardLifecycleStatus,
  cards,
  type Card,
  type CardLifecycleStatus,
  type NewCard,
} from './schema/cards';
export { companies, type Company, type NewCompany } from './schema/companies';
