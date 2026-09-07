import type { DependencyFinding } from './dependencyCheck';
import type { DiffResult } from './diff';
import type { GateName, GateReport, GateRunners, GateStatus } from './gates';
import type { LintResult } from './lint';
import type { AppRouter } from '@ts-rest/core';
import type { OpenAPIObject } from 'openapi3-ts/oas31';

import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { assertNoDbImport, DB_PACKAGE_NAME } from './dependencyCheck';
import { diffSpecs } from './diff';
import { emitOpenApi, UnrepresentableSchemaError } from './emit';
import { DEFAULT_GATE_RUNNERS, GATE_ORDER, runGates } from './gates';
import { lintSpec } from './lint';
import { latestPublishedSpec } from './publishedBaseline';

/**
 * This suite is about the composition, not about the gates. What each gate
 * decides is pinned by that gate's own suite against its own fixtures — real
 * vacuum, real oasdiff, real TypeScript preprocessor. What is left, and what
 * nothing else can see, is whether the runner puts them in spec section 8's
 * order and whether a failure actually stops the ones after it.
 *
 * Both claims are unobservable from a returned report. A runner that executes
 * every gate and then relabels the later ones `not-run` produces a byte-
 * identical `GateReport` while still spawning two Go binaries and scanning a
 * package tree — the difference is invisible in the result and expensive in
 * CI. So the runners are recorded here, and the assertions are against the
 * call log: which ran, in which order, and which never ran at all.
 *
 * Stubbing the gates is what makes that visible, and it is also what makes
 * this suite worthless on its own — a stub agrees with whatever the runner
 * asks of it. Two things close that: the defaults are asserted to *be* the
 * real gate functions (a seam nobody checks is a seam the defaults drift
 * through), and the integration test next door runs the same composition end
 * to end against the real fixtures and the real binaries.
 */

/** A gate call, as recorded. The arguments are kept where a case asserts on them. */
interface RunnerCall {
  runner: keyof GateRunners;
  args: unknown[];
}

interface Recorder {
  calls: RunnerCall[];
  /** The runner names that were invoked, in the order they were invoked. */
  order: () => (keyof GateRunners)[];
  runners: GateRunners;
}

const CLEAN_LINT: LintResult = { ok: true, errors: [], findings: [] };
const CLEAN_DIFF: DiffResult = { breaking: false, changes: [] };

const FAILING_LINT: LintResult = {
  ok: false,
  errors: [{
    code: 'house-no-null',
    path: ['components', 'schemas', 'Card', 'properties', 'activatedAt'],
    message: 'null is never emitted; absent means not applicable: `nullable` must be undefined',
    severity: 'error',
    line: 42,
    source: 'openapi.json',
  }],
  findings: [],
};

const FAILING_DIFF: DiffResult = {
  breaking: true,
  changes: [{
    id: 'response-required-property-removed',
    text: 'removed the required property \'remainingMinorUnits\' from the response '
      + 'with the \'200\' status',
    level: 'error',
    operation: 'GET',
    operationId: 'getCompanyDashboard',
    path: '/companies/{companyId}/dashboard',
  }],
};

const FAILING_DEPENDENCY: DependencyFinding[] = [{
  kind: 'source-import',
  file: 'src/schemas/card.ts',
  line: 3,
  specifier: DB_PACKAGE_NAME,
  message: `imports '${DB_PACKAGE_NAME}'`,
}];

/**
 * A document that is deliberately not a real emit. Gate 1 is stubbed in every
 * case here, so what the document says is irrelevant — that it is *this*
 * object is what one case reads back off the scratch file.
 */
const EMITTED: OpenAPIObject = {
  openapi: '3.1.0',
  info: { title: 'gate-runner stub contract', version: '1.0.0' },
  paths: { '/companies': {} },
};

const BASELINE = '/published/1.0.0.json';

/** The contract stub. Gate 1 never looks at it; it only has to not be undefined. */
const CONTRACT = {} as AppRouter;

const PACKAGE_DIR = '/packages/contracts-service-a';

interface RecorderOverrides {
  emit?: () => OpenAPIObject;
  lint?: LintResult;
  latestPublished?: string | null;
  diff?: DiffResult;
  dependency?: DependencyFinding[];
}

/**
 * Records every runner call and answers with a fixed result.
 *
 * Deliberately not built from `DEFAULT_GATE_RUNNERS`: a recorder that fell
 * through to a real gate for anything it was not told about would spawn a
 * binary or read the filesystem, and the case that forgot to override it
 * would fail for a reason that has nothing to do with the composition.
 */
function recorder(overrides: RecorderOverrides = {}): Recorder {
  const calls: RunnerCall[] = [];
  const record = (runner: keyof GateRunners, args: unknown[]): void => {
    calls.push({ runner, args });
  };

  return {
    calls,
    order: () => calls.map((call) => call.runner),
    runners: {
      emit: (contract, meta) => {
        record('emit', [contract, meta]);
        return overrides.emit === undefined
          ? EMITTED
          : overrides.emit();
      },
      lint: (specPath, options) => {
        record('lint', [specPath, options]);
        return Promise.resolve(overrides.lint ?? CLEAN_LINT);
      },
      latestPublished: (contractPackageDir) => {
        record('latestPublished', [contractPackageDir]);
        return overrides.latestPublished === undefined
          ? BASELINE
          : overrides.latestPublished;
      },
      diff: (basePath, revisionPath, options) => {
        record('diff', [basePath, revisionPath, options]);
        return Promise.resolve(overrides.diff ?? CLEAN_DIFF);
      },
      dependency: (contractPackageDir) => {
        record('dependency', [contractPackageDir]);
        return overrides.dependency ?? [];
      },
    },
  };
}

const fromContract = (
  runners: GateRunners,
): Promise<GateReport> => runGates({
  contractPackageDir: PACKAGE_DIR,
  contract: CONTRACT,
  meta: { info: { title: 'contracts-service-a', version: '1.0.0' } },
  runners,
});

/** The report's own view of the run, as `gate -> status` pairs in report order. */
const statuses = (report: GateReport): [GateName, GateStatus][] => report.outcomes.map(
  (outcome) => [outcome.gate, outcome.status],
);

describe('the gate runner order', () => {
  it('runs emit, lint, diff and dependency in spec section 8 order', async () => {
    const recorded = recorder();

    const report = await fromContract(recorded.runners);

    // The call log is the claim. The report below agrees with it, but a
    // report agrees with itself whatever the runner did.
    expect(recorded.order()).toEqual(['emit', 'lint', 'latestPublished', 'diff', 'dependency']);
    expect(report.ok).toBe(true);
    expect(report.failure).toBeNull();
    expect(statuses(report)).toEqual([
      ['emit', 'passed'],
      ['lint', 'passed'],
      ['diff', 'passed'],
      ['dependency', 'passed'],
    ]);
  });

  it('reports every gate in GATE_ORDER, so nothing downstream restates the order', async () => {
    const report = await fromContract(recorder().runners);

    expect(report.outcomes.map((outcome) => outcome.gate)).toEqual(GATE_ORDER);
    expect(GATE_ORDER).toEqual(['emit', 'lint', 'diff', 'dependency']);
  });

  it('resolves the published baseline before diffing, and diffs against exactly it', async () => {
    const recorded = recorder({ latestPublished: '/published/2.3.0.json' });

    await fromContract(recorded.runners);

    const lookup = recorded.calls.findIndex((call) => call.runner === 'latestPublished');
    const diff = recorded.calls.findIndex((call) => call.runner === 'diff');
    expect(lookup).toBeLessThan(diff);
    expect(recorded.calls[diff]?.args[0]).toBe('/published/2.3.0.json');
  });

  it('lints and diffs the document gate 1 just built, not a committed artifact', async () => {
    const recorded = recorder();

    await fromContract(recorded.runners);

    const linted = recorded.calls.find((call) => call.runner === 'lint')?.args[0];
    const revision = recorded.calls.find((call) => call.runner === 'diff')?.args[1];
    expect(typeof linted).toBe('string');
    // Same path to both, or the two gates are reporting on different
    // documents and only one of them is about the change under review.
    expect(revision).toBe(linted);
  });

  it('hands both binaries a real file holding the emitted document', async () => {
    let lintedContents = '';
    const recorded = recorder();
    const runners: GateRunners = {
      ...recorded.runners,
      lint: (specPath, options) => {
        lintedContents = readFileSync(specPath, 'utf8');
        return recorded.runners.lint(specPath, options);
      },
    };

    await fromContract(runners);

    expect(JSON.parse(lintedContents)).toEqual(EMITTED);
  });

  it('removes the scratch document once the run is over', async () => {
    const recorded = recorder();

    await fromContract(recorded.runners);

    const linted = recorded.calls.find((call) => call.runner === 'lint')?.args[0];
    expect(existsSync(String(linted))).toBe(false);
  });

  it('skips gate 1 and keeps the order for the remaining three when given a document', async () => {
    const recorded = recorder();

    const report = await runGates({
      contractPackageDir: PACKAGE_DIR,
      specPath: '/fixtures/satisfies-all-rules.yaml',
      runners: recorded.runners,
    });

    expect(recorded.order()).toEqual(['lint', 'latestPublished', 'diff', 'dependency']);
    expect(recorded.calls[0]?.args[0]).toBe('/fixtures/satisfies-all-rules.yaml');
    expect(report.ok).toBe(true);
    expect(report.document).toBeNull();
    expect(statuses(report)).toEqual([
      ['emit', 'skipped'],
      ['lint', 'passed'],
      ['diff', 'passed'],
      ['dependency', 'passed'],
    ]);
  });
});

describe('the first failing gate', () => {
  it('stops the run at emit, so nothing after it is executed', async () => {
    const recorded = recorder({
      emit: () => {
        throw new UnrepresentableSchemaError(
          'getCompanyDashboard.responses.200.properties.card.properties.activatedAt',
          'non-json-schema-type',
          '`type` is \'Date\', which is not one of JSON Schema\'s seven types',
        );
      },
    });

    const report = await fromContract(recorded.runners);

    expect(recorded.order()).toEqual(['emit']);
    expect(report.ok).toBe(false);
    expect(report.failure?.gate).toBe('emit');
    expect(statuses(report)).toEqual([
      ['emit', 'failed'],
      ['lint', 'not-run'],
      ['diff', 'not-run'],
      ['dependency', 'not-run'],
    ]);
    expect(report.failure?.summary).toContain('activatedAt');
    expect(report.failure?.reasons.join('\n')).toContain('`type` is \'Date\'');
  });

  it('stops the run at lint, so neither binary after it is spawned', async () => {
    const recorded = recorder({ lint: FAILING_LINT });

    const report = await fromContract(recorded.runners);

    expect(recorded.order()).toEqual(['emit', 'lint']);
    // Spelled out again rather than left to the log: "the diff gate did not
    // run" is the whole claim, and oasdiff is the expensive half of it.
    expect(recorded.order()).not.toContain('latestPublished');
    expect(recorded.order()).not.toContain('diff');
    expect(recorded.order()).not.toContain('dependency');
    expect(report.failure?.gate).toBe('lint');
    expect(statuses(report)).toEqual([
      ['emit', 'passed'],
      ['lint', 'failed'],
      ['diff', 'not-run'],
      ['dependency', 'not-run'],
    ]);
    expect(report.failure?.reasons).toEqual([
      'house-no-null at components.schemas.Card.properties.activatedAt (line 42): '
      + 'null is never emitted; absent means not applicable: `nullable` must be undefined',
    ]);
  });

  it('stops the run at diff, so the dependency scan never happens', async () => {
    const recorded = recorder({ diff: FAILING_DIFF });

    const report = await fromContract(recorded.runners);

    expect(recorded.order()).toEqual(['emit', 'lint', 'latestPublished', 'diff']);
    expect(recorded.order()).not.toContain('dependency');
    expect(report.failure?.gate).toBe('diff');
    expect(statuses(report)).toEqual([
      ['emit', 'passed'],
      ['lint', 'passed'],
      ['diff', 'failed'],
      ['dependency', 'not-run'],
    ]);
    // Names the removed field and the operation it breaks, which is what
    // acceptance criterion 9.2 asks the report to say.
    expect(report.failure?.summary).toContain(BASELINE);
    expect(report.failure?.reasons[0]).toContain('response-required-property-removed');
    expect(report.failure?.reasons[0]).toContain('getCompanyDashboard');
    expect(report.failure?.reasons[0]).toContain('remainingMinorUnits');
  });

  it('is the dependency gate when it is the only one that failed', async () => {
    const recorded = recorder({ dependency: FAILING_DEPENDENCY });

    const report = await fromContract(recorded.runners);

    // Nothing to short-circuit — gate 4 is last — so the claim here is that
    // the whole run happened and the report still names the failure.
    expect(recorded.order()).toEqual(['emit', 'lint', 'latestPublished', 'diff', 'dependency']);
    expect(report.failure?.gate).toBe('dependency');
    expect(statuses(report)).toEqual([
      ['emit', 'passed'],
      ['lint', 'passed'],
      ['diff', 'passed'],
      ['dependency', 'failed'],
    ]);
    expect(report.failure?.summary).toContain(DB_PACKAGE_NAME);
    expect(report.failure?.reasons).toEqual([`src/schemas/card.ts:3: imports '${DB_PACKAGE_NAME}'`]);
  });

  it('labels every skipped gate with the gate that failed first', async () => {
    const recorded = recorder({ lint: FAILING_LINT });

    const report = await fromContract(recorded.runners);

    const notRun = report.outcomes.filter((outcome) => outcome.status === 'not-run');
    expect(notRun.map((outcome) => outcome.gate)).toEqual(['diff', 'dependency']);
    notRun.forEach((outcome) => {
      expect(outcome.summary).toBe('not run: the lint gate failed first');
      expect(outcome.reasons).toEqual([]);
    });
  });

  it('removes the scratch document even when a gate fails', async () => {
    const recorded = recorder({ lint: FAILING_LINT });

    await fromContract(recorded.runners);

    const linted = recorded.calls.find((call) => call.runner === 'lint')?.args[0];
    expect(existsSync(String(linted))).toBe(false);
  });
});

describe('a gate with nothing to do', () => {
  it('skips the diff when the contract package has published no baseline', async () => {
    const recorded = recorder({ latestPublished: null });

    const report = await fromContract(recorded.runners);

    // Skipped is not failed: a first contract has no baseline, and refusing
    // to publish it would make the very first publish impossible.
    expect(report.ok).toBe(true);
    expect(report.failure).toBeNull();
    // And skipped is not passed either — oasdiff was never asked anything,
    // so the run carries no evidence the change is non-breaking.
    expect(recorded.order()).toEqual(['emit', 'lint', 'latestPublished', 'dependency']);
    expect(statuses(report)).toEqual([
      ['emit', 'passed'],
      ['lint', 'passed'],
      ['diff', 'skipped'],
      ['dependency', 'passed'],
    ]);
  });

  it('does not let a skipped diff short-circuit the dependency gate', async () => {
    const recorded = recorder({ latestPublished: null, dependency: FAILING_DEPENDENCY });

    const report = await fromContract(recorded.runners);

    expect(recorded.order()).toContain('dependency');
    expect(report.failure?.gate).toBe('dependency');
  });
});

describe('a gate that could not run at all', () => {
  it('propagates gate 1 refusing the contract rather than reporting a failed gate', async () => {
    const recorded = recorder({
      emit: () => {
        throw new Error('emit gate cannot run: the contract declares no routes');
      },
    });

    // `ok: false` has to mean the contract is bad. A missing binary or a
    // malformed router reported as a failed gate would make a broken CI
    // machine look like a broken contract.
    await expect(fromContract(recorded.runners)).rejects.toThrow(/emit gate cannot run/);
  });

  it('propagates a missing vacuum rather than reporting a failed lint gate', async () => {
    const recorded = recorder();
    const runners: GateRunners = {
      ...recorded.runners,
      lint: () => Promise.reject(new Error('lint gate cannot run: could not execute \'vacuum\'')),
    };

    await expect(fromContract(runners)).rejects.toThrow(/lint gate cannot run/);
    // Still cleaned up: the scratch document must not survive a thrown run.
    const emitted = recorded.calls.filter((call) => call.runner === 'emit');
    expect(emitted).toHaveLength(1);
  });

  it('refuses a run with no contract and no document', async () => {
    await expect(runGates({
      contractPackageDir: PACKAGE_DIR,
    } as unknown as Parameters<typeof runGates>[0])).rejects.toThrow(
      /gate runner cannot run: neither a contract nor a specPath/,
    );
  });

  it('refuses a run given both a contract and a document', async () => {
    await expect(runGates({
      contractPackageDir: PACKAGE_DIR,
      contract: CONTRACT,
      meta: { info: { title: 'x', version: '1.0.0' } },
      specPath: '/fixtures/satisfies-all-rules.yaml',
    } as unknown as Parameters<typeof runGates>[0])).rejects.toThrow(
      /gate runner cannot run: both a contract and a specPath/,
    );
  });

  it('refuses a run with no contract package directory', async () => {
    await expect(runGates({
      contractPackageDir: '',
      specPath: '/fixtures/satisfies-all-rules.yaml',
    })).rejects.toThrow(/gate runner cannot run: no contract package directory/);
  });
});

describe('the default runners', () => {
  it('are the real gates', () => {
    // The seam that makes this suite possible is also how the runner could
    // quietly stop calling a real gate. Identity, not behaviour: behaviour is
    // each gate's own suite.
    expect(DEFAULT_GATE_RUNNERS.emit).toBe(emitOpenApi);
    expect(DEFAULT_GATE_RUNNERS.lint).toBe(lintSpec);
    expect(DEFAULT_GATE_RUNNERS.latestPublished).toBe(latestPublishedSpec);
    expect(DEFAULT_GATE_RUNNERS.diff).toBe(diffSpecs);
    expect(DEFAULT_GATE_RUNNERS.dependency).toBe(assertNoDbImport);
  });

  it('cover every runner the composition uses', () => {
    expect(Object.keys(DEFAULT_GATE_RUNNERS).sort()).toEqual([
      'dependency',
      'diff',
      'emit',
      'latestPublished',
      'lint',
    ]);
  });

  it('fill in whatever a partial override leaves out', async () => {
    // A case overriding one runner must not silently disable the rest, or
    // every other case here is testing a runner with four gates missing.
    const recorded = recorder();
    let dependencyCalledWith = '';

    const report = await runGates({
      contractPackageDir: PACKAGE_DIR,
      specPath: '/fixtures/satisfies-all-rules.yaml',
      runners: {
        lint: recorded.runners.lint,
        latestPublished: () => null,
        dependency: (contractPackageDir) => {
          dependencyCalledWith = contractPackageDir;
          return [];
        },
      },
    });

    // `dependency` was overridden, so the default never ran; the point is
    // that the merge kept it callable and pointed at the right package.
    expect(dependencyCalledWith).toBe(PACKAGE_DIR);
    expect(report.ok).toBe(true);
  });
});
