/**
 * Public surface of `@marcos-corp/contracts-service-a`.
 *
 * Placeholder: the TypeBox schemas (shared primitives, the error schema, the
 * company, card, transaction and dashboard shapes) and the ts-rest contract
 * that exposes them land in later tasks and are re-exported here.
 *
 * Two constraints bind everything added to this package:
 *
 * - Schemas are hand-authored in TypeBox and never derived from
 *   `@marcos-corp/db` (spec 2.1). This package must not depend on it.
 * - The package `version` is what consumers pin exactly, with no range
 *   specifier (spec 2.2), so a bump here is a reviewable event for every
 *   consumer rather than an implicit upgrade.
 */

export {};
