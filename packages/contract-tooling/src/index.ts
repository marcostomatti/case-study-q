/**
 * Public surface of `@marcos-corp/contract-tooling`.
 *
 * `lintSpec` is gate 2 of the four blocking gates in spec section 8. The
 * breaking-change diff (`diffSpecs`), the published-baseline resolver, the
 * OpenAPI emitter, the `@marcos-corp/db` dependency check, the exact-pin
 * check and the gate runner that composes them land in later tasks and are
 * re-exported here alongside it.
 */

export type {
  LintFinding,
  LintOptions,
  LintResult,
  LintSeverity,
} from './lint';
export { HOUSE_RULESET_PATH, lintSpec, SPEC_PARSE_FAILED } from './lint';
