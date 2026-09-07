/**
 * Entrypoint and public surface of `@marcos-corp/service-a`, the provider for
 * cards and transactions.
 *
 * Placeholder: the Zod-parsed env config, the client identity middleware, the
 * usage logger, the Drizzle-row-to-contract mapping layer, the ts-rest routes
 * and the Express `server.ts` factory land in later tasks and are wired in
 * here. `bun run dev` runs this file, so it becomes the process entrypoint
 * once `server.ts` exists.
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
 */

export {};
