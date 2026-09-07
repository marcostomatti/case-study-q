/**
 * Public surface of `@marcos-corp/contracts-service-b`.
 *
 * Placeholder: the TypeBox invoice schema — whose payment state enum carries an
 * explicit `unknown` member — and the ts-rest contract exposing the due-invoice
 * operation land in later tasks and are re-exported here.
 *
 * Two constraints bind everything added to this package:
 *
 * - Schemas are hand-authored in TypeBox and never derived from
 *   `@marcos-corp/db` (spec 2.1). This package must not depend on it.
 * - The package `version` is what consumers pin exactly, with no range
 *   specifier (spec 2.2), so a bump here is a reviewable event for every
 *   consumer rather than an implicit upgrade.
 *
 * service-b is the case that proves ownership shifts: it publishes this
 * contract while consuming `@marcos-corp/contracts-service-a`, so the same
 * package is a provider surface here and a pinned dependency there.
 */

export {};
