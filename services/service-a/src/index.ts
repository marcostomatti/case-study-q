/**
 * Entrypoint and public surface of `@marcos-corp/service-a`, the provider for
 * cards and transactions.
 *
 * What has landed: `config/env.ts`, the Zod-parsed environment,
 * `auth/clientIdentity.ts`, the consumer identity spec section 2.3 requires on
 * every request, `telemetry/usageLogger.ts`, the `api_usage` row it writes for
 * each one, `mapping/`, the Drizzle-row-to-contract translation that keeps
 * the database schema out of the published payloads — including
 * `dashboardMapper.ts`, which assembles the mobile view's whole payload and
 * computes the two figures on it that no column holds — and `repositories/`,
 * the only place this service reaches Postgres. Still to come and wired in
 * here as they arrive: the ts-rest routes and the Express `server.ts` factory.
 * `bun run dev` runs this file, so it becomes the process entrypoint once
 * `server.ts` exists.
 *
 * Mount order is a property of this package rather than of any one module, and
 * `server.ts` inherits it: `clientIdentityMiddleware` first, then
 * `usageLoggerMiddleware`, then the router. The logger reads an identity the
 * auth middleware resolved and refuses a request that arrives without one, so
 * the reverse order turns every request into a `500`.
 *
 * Two constraints bind everything added to this package:
 *
 * - The contract schemas stay in `@marcos-corp/contracts-service-a` and stay
 *   TypeBox. Zod is the tool for everything internal to this service — env
 *   parsing, post-parse coercion, repository-layer shapes — and never crosses
 *   into a contract package.
 * - Drizzle row shapes from `@marcos-corp/db` never reach a response. The
 *   mapping layer translates them, which is what lets a column rename stay a
 *   non-breaking change.
 *
 * Re-exporting a module here must stay side-effect free. `loadServiceEnv` is a
 * function rather than a parsed singleton for exactly that reason,
 * `buildConsumerRegistry` is one for the same reason, and `apiUsageSink` and
 * every repository take a database rather than opening one: importing this
 * file must not require an environment, a configured consumer registry or a
 * reachable Postgres. `src/testing/` is the one directory deliberately left
 * out of this file — it stands a database up, which is exactly what importing
 * this package must not do.
 */

export {
  buildConsumerRegistry,
  clientIdentityMiddleware,
  ConsumerRegistryError,
  CREDENTIAL_SCHEME,
  fingerprintCredential,
  readClientIdentity,
  requireClientIdentity,
  resolveClientIdentity,
  UNAUTHENTICATED_STATUS,
} from './auth/clientIdentity';
export type {
  ClientIdentity,
  ClientIdentityResolution,
  ConsumerRegistry,
  CredentialRejection,
  RegisteredConsumer,
} from './auth/clientIdentity';
export {
  EnvironmentError,
  loadServiceEnv,
  SERVICE_ENV_VARIABLES,
  serviceEnvSchema,
} from './config/env';
export type { EnvProblem, EnvVariable, ServiceEnv } from './config/env';
export {
  resolveCardArtUrl,
  toContractCard,
  toContractCardState,
} from './mapping/cardMapper';
export type { CardMappingOptions } from './mapping/cardMapper';
export {
  settledSpendMinorUnits,
  toCompanySummary,
  toDashboard,
} from './mapping/dashboardMapper';
export type { DashboardSources } from './mapping/dashboardMapper';
export {
  MERCHANT_CATEGORY_RANGES,
  toContractMerchantCategory,
  toContractSettlementState,
  toContractTransaction,
} from './mapping/transactionMapper';
export type { MerchantCategoryRange } from './mapping/transactionMapper';
export {
  ACTIVATABLE_LIFECYCLE_STATUSES,
  activateCard,
  ACTIVATED_LIFECYCLE_STATUS,
  findCardById,
  findCompanyCard,
} from './repositories/cardRepository';
export type { CardActivation, CardLookup } from './repositories/cardRepository';
export { findCompanyById, listCompanies } from './repositories/companyRepository';
export type { ServiceDatabase } from './repositories/database';
export {
  assertPageRequest,
  pageRequestSchema,
  PageRequestError,
  readTotal,
} from './repositories/pagination';
export type { Page, PageRequest } from './repositories/pagination';
export {
  DASHBOARD_RESET_PERIOD,
  findCurrentSpendLimit,
} from './repositories/spendLimitRepository';
export type { SpendLimitLookup } from './repositories/spendLimitRepository';
export {
  countCompanyTransactions,
  findDashboardTransactions,
  listCompanyTransactions,
} from './repositories/transactionRepository';
export type {
  CompanyTransactionCriteria,
  DashboardTransactionCriteria,
} from './repositories/transactionRepository';
export {
  apiUsageSink,
  CONSUMER_PACKAGE_HEADER,
  recordOperation,
  UNROUTED_OPERATION_ID,
  UNSTATED_CONSUMER_PACKAGE,
  usageLoggerMiddleware,
} from './telemetry/usageLogger';
export type {
  UsageDatabase,
  UsageEvent,
  UsageFailureReporter,
  UsageLoggerOptions,
  UsageSink,
} from './telemetry/usageLogger';
