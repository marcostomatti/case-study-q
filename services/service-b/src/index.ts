/**
 * Entrypoint and public surface of `@marcos-corp/service-b`, the provider for
 * invoices and — the reason this package exists — a consumer of `service-a`.
 *
 * Placeholder: the ts-rest typed client for `@marcos-corp/contracts-service-a`,
 * the due-invoice routes and the Express server factory land in later tasks and
 * are wired in here. `bun run dev` runs this file, so it becomes the process
 * entrypoint once `server.ts` exists.
 *
 * The same two constraints as `service-a` bind everything added here — contract
 * schemas stay TypeBox inside a contracts package with Zod reserved for
 * internals, and Drizzle rows never reach a response — plus one this package
 * carries alone:
 *
 * - As a consumer, it pins `@marcos-corp/contracts-service-a` at an exact
 *   version with no range specifier, sends its own `client_id`, and tolerates
 *   unknown fields in a `service-a` response. A provider consuming another
 *   provider is reviewed through exactly the same CODEOWNERS path an app is;
 *   that equivalence is what this package proves.
 */

export {};
