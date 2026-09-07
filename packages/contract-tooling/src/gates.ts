/**
 * The gate runner: the four blocking gates of spec section 8, composed in the
 * one order that spec fixes, stopping at the first failure.
 *
 *   1. emit        build the OpenAPI document from the ts-rest contract
 *   2. lint        vacuum against the house ruleset
 *   3. diff        oasdiff against the highest published baseline
 *   4. dependency  no contract package imports the database package
 *
 * The order is the point of this module, not an implementation detail of it.
 * Emit runs first so that a lint error is never reported against a document
 * that could not be built, and diff runs after lint so that a document vacuum
 * has already rejected is never compared against a published baseline — a
 * document that is valid YAML but is not an OpenAPI description diffs as
 * *every path removed*, which reads as a catastrophic breaking change rather
 * than as the malformed document it is. Running gate 4 last is the cheap one
 * going last, and nothing else.
 *
 * ## Short-circuiting, and why the report still lists four gates
 *
 * A failed gate stops the run. Everything after it is reported with status
 * `not-run` rather than being dropped from the report: a caller printing the
 * report should be able to say "diff and dependency never ran because lint
 * failed", and a report that simply ends early is indistinguishable from one
 * where the later gates passed.
 *
 * `skipped` is a third outcome and is not a quiet `passed`. Gate 3 is skipped
 * when the contract package has published nothing yet — there is genuinely
 * nothing to diff against — and gate 1 is skipped when the caller supplied an
 * already-built document instead of a contract. Neither is a failure, and
 * neither is evidence that the gate would have passed.
 *
 * ## What gates 2 and 3 actually read
 *
 * The document gate 1 just built, written to a scratch file for the two Go
 * binaries that only take paths — never the committed
 * `openapi/openapi.json`. Linting the committed artifact would report on
 * whatever was last emitted rather than on the change under review, and
 * diffing it would report "no breaking changes" about a document nobody
 * wrote. The committed artifact is kept honest separately, by the
 * byte-identity test in each contract package.
 *
 * ## Failure versus cannot-run
 *
 * Every gate this composes makes the same split, and so does this one: the
 * thing under test being bad is a returned result, the gate being unable to
 * run is a throw. So `ok: false` always means the contract is bad and never
 * means the CI machine is missing a binary. Concretely, gate 1 throws two
 * different things and they are not the same event —
 * `UnrepresentableSchemaError` means the contract is unpublishable and is
 * caught here as a failed gate, while a plain `Error` prefixed `emit gate
 * cannot run:` propagates untouched, as do the equivalents from every other
 * gate.
 */
import type { DependencyFinding } from './dependencyCheck';
import type { BreakingChange, DiffOptions, DiffResult } from './diff';
import type { EmitMeta } from './emit';
import type { LintFinding, LintOptions, LintResult } from './lint';
import type { AppRouter } from '@ts-rest/core';
import type { OpenAPIObject } from 'openapi3-ts/oas31';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertNoDbImport, DB_PACKAGE_NAME } from './dependencyCheck';
import { diffSpecs } from './diff';
import { emitOpenApi, UnrepresentableSchemaError } from './emit';
import { lintSpec } from './lint';
import { latestPublishedSpec } from './publishedBaseline';

/** The four blocking gates of spec section 8, in the order they must run. */
export type GateName = 'emit' | 'lint' | 'diff' | 'dependency';

/**
 * Spec section 8's order, exported so a caller asserting it — a test, the
 * pipeline simulation, the CI job — reads it from here rather than restating
 * it and drifting.
 */
export const GATE_ORDER: readonly GateName[] = ['emit', 'lint', 'diff', 'dependency'];

/**
 * `skipped` and `not-run` are deliberately distinct. `skipped` means the gate
 * had nothing to do and says nothing about the contract; `not-run` means an
 * earlier gate failed and this one never got the chance. Collapsing either
 * into `passed` is how a gate stops gating.
 */
export type GateStatus = 'passed' | 'failed' | 'skipped' | 'not-run';

export interface GateOutcome {
  gate: GateName;
  status: GateStatus;
  /** One sentence naming what this gate did or found. */
  summary: string;
  /**
   * The individual violations, one string per finding: the house rules that
   * fired, the breaking changes, the database imports. Empty unless the gate
   * failed.
   */
  reasons: string[];
}

export interface GateReport {
  /** True when no gate failed. A skipped gate does not make a run fail. */
  ok: boolean;
  /** The package the run was about, as it was passed in. */
  contractPackageDir: string;
  /**
   * Always all four gates, always in {@link GATE_ORDER}, whatever happened.
   * Gates after a failure carry status `not-run`.
   */
  outcomes: GateOutcome[];
  /** The gate that failed, with its reasons, or `null` when none did. */
  failure: GateOutcome | null;
  /** What gate 1 built, or `null` when a document was supplied instead. */
  document: OpenAPIObject | null;
}

/**
 * The five functions the runner composes, behind one seam.
 *
 * This exists so the composition itself is observable. Whether a failing gate
 * short-circuits the ones after it cannot be read off a returned status —
 * an implementation that runs every gate and then relabels the later ones
 * `not-run` produces exactly the same report, while still spawning vacuum and
 * oasdiff. Recording which runners were called, in which order, is the only
 * evidence that separates the two.
 *
 * `latestPublished` is not a gate; it is what supplies gate 3 with its base
 * document, and it is here for the same reason — a run where gate 3 was
 * skipped and a run where it passed differ by whether this was consulted.
 */
export interface GateRunners {
  emit: (contract: AppRouter, meta: EmitMeta) => OpenAPIObject;
  lint: (specPath: string, options?: LintOptions) => Promise<LintResult>;
  latestPublished: (contractPackageDir: string) => string | null;
  diff: (basePath: string, revisionPath: string, options?: DiffOptions) => Promise<DiffResult>;
  dependency: (contractPackageDir: string) => DependencyFinding[];
}

/** The real gates. Anything overriding one of these is not running that gate. */
export const DEFAULT_GATE_RUNNERS: GateRunners = {
  emit: emitOpenApi,
  lint: lintSpec,
  latestPublished: latestPublishedSpec,
  diff: diffSpecs,
  dependency: assertNoDbImport,
};

interface CommonOptions {
  /**
   * The contract package under review. Gate 3 resolves its published
   * baseline from here and gate 4 scans it, so this is required even when the
   * document is supplied directly.
   */
  contractPackageDir: string;
  /** Passed through to `lintSpec` — the ruleset and the vacuum binary. */
  lintOptions?: LintOptions;
  /** Passed through to `diffSpecs` — the oasdiff binary. */
  diffOptions?: DiffOptions;
  /** Overrides for {@link DEFAULT_GATE_RUNNERS}, merged over the defaults. */
  runners?: Partial<GateRunners>;
}

/** Run all four gates, starting from the contract itself. */
export interface RunGatesFromContractOptions extends CommonOptions {
  contract: AppRouter;
  meta: EmitMeta;
  specPath?: never;
}

/**
 * Run gates 2 to 4 against a document that already exists, skipping gate 1.
 *
 * For a document this repo did not emit — a fixture, or an artifact from
 * before the emitter existed. A contract package's own pull request always
 * goes through the contract, or gate 1 is not gating anything.
 */
export interface RunGatesFromDocumentOptions extends CommonOptions {
  specPath: string;
  contract?: never;
  meta?: never;
}

export type RunGatesOptions = RunGatesFromContractOptions | RunGatesFromDocumentOptions;

/** Prefix every "the runner itself could not run" message carries. */
const CANNOT_RUN = 'gate runner cannot run:';

const cannotRun = (detail: string): Error => new Error(`${CANNOT_RUN} ${detail}`);

function plural(count: number, singular: string, many: string): string {
  const noun = count === 1
    ? singular
    : many;
  return `${count} ${noun}`;
}

const passed = (gate: GateName, summary: string): GateOutcome => ({
  gate,
  status: 'passed',
  summary,
  reasons: [],
});

const skipped = (gate: GateName, summary: string): GateOutcome => ({
  gate,
  status: 'skipped',
  summary,
  reasons: [],
});

const failed = (gate: GateName, summary: string, reasons: string[]): GateOutcome => ({
  gate,
  status: 'failed',
  summary,
  reasons,
});

function describeLintFinding(finding: LintFinding): string {
  // vacuum cannot always render a path — on a `$ref`-resolved copy it prints
  // the raw filter instead — but its line number is correct either way, so
  // the line is what a human gets pointed at.
  const where = finding.path.length > 0
    ? finding.path.join('.')
    : finding.source;
  const line = finding.line === undefined
    ? ''
    : ` (line ${finding.line})`;
  return `${finding.code} at ${where}${line}: ${finding.message}`;
}

function describeBreakingChange(change: BreakingChange): string {
  // The operationId is what `api_usage` keys on, so it is the identifier that
  // answers "who is calling the thing this breaks". Fall back to the method
  // and path when oasdiff attributed the change to no operation.
  const operation = change.operationId
    ?? [change.operation, change.path].filter((part) => part !== undefined).join(' ');
  const where = operation.length > 0
    ? ` (${operation})`
    : '';
  return `${change.id}${where}: ${change.text}`;
}

function describeDependencyFinding(finding: DependencyFinding): string {
  const where = finding.kind === 'manifest-dependency'
    ? `${finding.file} (${finding.field})`
    : `${finding.file}:${finding.line}`;
  return `${where}: ${finding.message}`;
}

/**
 * Closes a report: pads the gates that never ran and derives `ok`.
 *
 * The padding is taken from {@link GATE_ORDER} rather than from a list built
 * alongside the run, so a report can never disagree with the documented order
 * about which gates exist or what comes after what.
 */
function finish(
  contractPackageDir: string,
  outcomes: GateOutcome[],
  document: OpenAPIObject | null,
): GateReport {
  const failure = outcomes.find((outcome) => outcome.status === 'failed') ?? null;

  const notRun: GateOutcome[] = failure === null
    ? []
    : GATE_ORDER.slice(outcomes.length).map((gate) => ({
      gate,
      status: 'not-run' as const,
      summary: `not run: the ${failure.gate} gate failed first`,
      reasons: [],
    }));

  return {
    ok: failure === null,
    contractPackageDir,
    outcomes: [...outcomes, ...notRun],
    failure,
    document,
  };
}

/**
 * Runs the four blocking gates of spec section 8 in order and reports the
 * first one that failed.
 *
 * Resolves with `ok: false` and a `failure` naming the gate and its reasons
 * when the contract is bad. Throws when a gate could not run at all — a
 * missing vacuum or oasdiff, an unreadable contract package, a contract that
 * is not a router — because a gate that could not run must never be mistaken
 * for a gate that passed.
 */
export async function runGates(options: RunGatesOptions): Promise<GateReport> {
  const runners: GateRunners = { ...DEFAULT_GATE_RUNNERS, ...options.runners };
  const { contractPackageDir } = options;

  if (typeof contractPackageDir !== 'string' || contractPackageDir.length === 0) {
    throw cannotRun('no contract package directory was supplied, so gates 3 and 4 have nothing to read');
  }

  const { contract } = options;
  const suppliedSpec = options.specPath;
  if ((contract === undefined) === (suppliedSpec === undefined)) {
    throw cannotRun(contract === undefined
      ? 'neither a contract nor a specPath was supplied, so there is no document to gate'
      : 'both a contract and a specPath were supplied, so which document gates 2 and 3 '
        + 'would read is ambiguous');
  }

  const outcomes: GateOutcome[] = [];
  let document: OpenAPIObject | null = null;
  let scratchDir: string | null = null;

  try {
    let specPath: string;

    if (contract === undefined) {
      // Unreachable given the check above; narrowing, not defence.
      if (suppliedSpec === undefined) throw cannotRun('there is no document to gate');
      specPath = suppliedSpec;
      outcomes.push(skipped(
        'emit',
        `no contract was supplied, so gates 2 and 3 read the document at '${specPath}' as given`,
      ));
    } else {
      const { meta } = options;
      if (meta === undefined) {
        throw cannotRun('a contract was supplied without the document metadata gate 1 needs');
      }

      try {
        document = runners.emit(contract, meta);
      } catch (error) {
        // The two things gate 1 throws are not the same event. An
        // unrepresentable schema is a fact about the contract and is this
        // gate failing; anything else means the gate could not run.
        if (!(error instanceof UnrepresentableSchemaError)) throw error;
        outcomes.push(failed(
          'emit',
          `the contract declares a schema the OpenAPI document cannot state, at '${error.path}'`,
          [error.message],
        ));
        return finish(contractPackageDir, outcomes, document);
      }

      scratchDir = mkdtempSync(join(tmpdir(), 'contract-gates-'));
      specPath = join(scratchDir, 'openapi.json');
      writeFileSync(specPath, `${JSON.stringify(document, null, 2)}\n`);
      outcomes.push(passed('emit', 'the contract emits an OpenAPI document with no unrepresentable schema'));
    }

    const lint = await runners.lint(specPath, options.lintOptions);
    if (!lint.ok) {
      outcomes.push(failed(
        'lint',
        `the document breaks ${plural(lint.errors.length, 'house rule', 'house rules')}`,
        lint.errors.map(describeLintFinding),
      ));
      return finish(contractPackageDir, outcomes, document);
    }
    outcomes.push(passed('lint', 'the document satisfies every house rule'));

    const basePath = runners.latestPublished(contractPackageDir);
    if (basePath === null) {
      outcomes.push(skipped(
        'diff',
        `'${contractPackageDir}' has published no baseline yet, so there is nothing to diff against`,
      ));
    } else {
      const diff = await runners.diff(basePath, specPath, options.diffOptions);
      if (diff.breaking) {
        outcomes.push(failed(
          'diff',
          `${plural(diff.changes.length, 'breaking change', 'breaking changes')} against the `
          + `published baseline '${basePath}'`,
          diff.changes.map(describeBreakingChange),
        ));
        return finish(contractPackageDir, outcomes, document);
      }
      outcomes.push(passed('diff', `no breaking change against the published baseline '${basePath}'`));
    }

    const dependencies = runners.dependency(contractPackageDir);
    if (dependencies.length > 0) {
      outcomes.push(failed(
        'dependency',
        `the contract package reaches ${DB_PACKAGE_NAME} in `
        + `${plural(dependencies.length, 'place', 'places')}`,
        dependencies.map(describeDependencyFinding),
      ));
      return finish(contractPackageDir, outcomes, document);
    }
    outcomes.push(passed('dependency', `the contract package does not depend on ${DB_PACKAGE_NAME}`));

    return finish(contractPackageDir, outcomes, document);
  } finally {
    // The scratch document exists only so vacuum and oasdiff, which take
    // paths, can read what gate 1 built. Nothing outside this function should
    // ever hold that path, so it goes away however the run ended.
    if (scratchDir !== null) rmSync(scratchDir, { recursive: true, force: true });
  }
}
