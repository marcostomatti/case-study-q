/**
 * Public surface of `@marcos-corp/contract-tooling`.
 *
 * `lintSpec` is gate 2, `diffSpecs` is gate 3 and `assertNoDbImport` is gate 4
 * of the four blocking gates in spec section 8, and `latestPublishedSpec` is
 * what supplies `diffSpecs` with its base document. `assertExactContractPins`
 * sits beside those four rather than inside them: it reads a consumer's
 * manifest rather than a contract package, and CI runs it as its own job. The
 * OpenAPI emitter and the gate runner that composes the four land in later
 * tasks and are re-exported here alongside them.
 *
 * `runBinary` is deliberately not exported: it is how this package starts a
 * gate binary, not something a caller should reach for. Anything needing
 * vacuum or oasdiff should go through the gate that wraps it.
 */

export type {
  BreakingChange,
  BreakingChangeLevel,
  ChangeLocation,
  DiffOptions,
  DiffResult,
} from './diff';
export { diffSpecs } from './diff';
export type {
  DependencyFinding,
  ManifestDependencyFinding,
  SourceImportFinding,
} from './dependencyCheck';
export { assertNoDbImport, DB_PACKAGE_NAME } from './dependencyCheck';
export type {
  LintFinding,
  LintOptions,
  LintResult,
  LintSeverity,
} from './lint';
export { HOUSE_RULESET_PATH, lintSpec, SPEC_PARSE_FAILED } from './lint';
export type { PinFinding, PinViolationReason } from './pinCheck';
export { assertExactContractPins, CONTRACT_PACKAGE_PREFIX } from './pinCheck';
export { latestPublishedSpec } from './publishedBaseline';
