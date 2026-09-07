/**
 * Public surface of `@marcos-corp/contract-tooling`.
 *
 * `emitOpenApi` is gate 1, `lintSpec` gate 2, `diffSpecs` gate 3 and
 * `assertNoDbImport` gate 4 of the four blocking gates in spec section 8, and
 * `latestPublishedSpec` is what supplies `diffSpecs` with its base document.
 * `assertExactContractPins` sits beside those four rather than inside them: it
 * reads a consumer's manifest rather than a contract package, and CI runs it
 * as its own job.
 *
 * `runGates` composes the four in spec section 8's order and is what a caller
 * should reach for. Calling them individually is fine for a one-off, but the
 * order is a governance decision rather than a convenience, so anything
 * running all four — `scripts/pipeline-simulation.ts`, the CI contracts job,
 * the acceptance scripts — should go through the runner rather than sequence
 * them again.
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
export type { EmitMeta, UnrepresentableReason } from './emit';
export {
  COMPONENT_REF_PREFIX,
  emitOpenApi,
  OPENAPI_VERSION,
  UnrepresentableSchemaError,
} from './emit';
export type {
  GateName,
  GateOutcome,
  GateReport,
  GateRunners,
  GateStatus,
  RunGatesFromContractOptions,
  RunGatesFromDocumentOptions,
  RunGatesOptions,
} from './gates';
export { DEFAULT_GATE_RUNNERS, GATE_ORDER, runGates } from './gates';
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
