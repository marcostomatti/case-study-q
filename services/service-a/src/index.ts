/**
 * Entrypoint and public surface of `@marcos-corp/service-a`, the provider for
 * cards and transactions.
 *
 * What has landed: `config/env.ts`, the Zod-parsed environment, and
 * `auth/clientIdentity.ts`, the consumer identity spec section 2.3 requires on
 * every request. Still to come and wired in here as they arrive: the usage
 * logger, the Drizzle-row-to-contract mapping layer, the ts-rest routes and the
 * Express `server.ts` factory. `bun run dev` runs this file, so it becomes the
 * process entrypoint once `server.ts` exists.
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
 * function rather than a parsed singleton for exactly that reason, and
 * `buildConsumerRegistry` is one for the same reason: importing this file must
 * not require an environment or a configured consumer registry.
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
