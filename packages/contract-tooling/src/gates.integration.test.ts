import type { GateName, GateOutcome, GateReport, GateStatus } from './gates';

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { DB_PACKAGE_NAME } from './dependencyCheck';
import { diffSpecs } from './diff';
import { runGates } from './gates';
import { lintSpec } from './lint';

/**
 * The end-to-end half of the gate runner's coverage.
 *
 * `gates.test.ts` next door is about the composition and nothing else: it
 * records an injectable seam and asserts which runners were called, in which
 * order, and which never ran. That is the only way to see ordering and
 * short-circuiting, and it is also why that suite proves nothing on its own —
 * a stub agrees with whatever the runner asks of it, so a runner wired to four
 * gates that do not work looks identical there.
 *
 * This file closes that. No runner overrides, the real `vacuum` and `oasdiff`
 * binaries, the committed fixtures, and a real contract package on disk with a
 * real `openapi/published/` directory. What it asserts is what a caller
 * actually gets back: a passing `GateReport` for a document the house ruleset
 * accepts, and a report naming the diff gate for a revision that removes a
 * required response field.
 *
 * ## Why every passing gate here is paired with a failing one
 *
 * A gate that always passes and a gate that works produce the same passing
 * report, so the passing cases below are worth nothing alone. Each gate that
 * a passing report claims is therefore shown failing somewhere in this file,
 * varied along the one axis under test:
 *
 *   lint        pinned by `lint.test.ts` against a fixture per house rule
 *   diff        passes on the additive revision, fails on the removal —
 *               same package, same baseline, only the document differs
 *   dependency  passes on a clean package, fails on the same published
 *               package once it reaches the database package
 *
 * The diff pair is the load-bearing one: without the additive case, a diff
 * gate that failed unconditionally would satisfy every other assertion here.
 *
 * ## Why the removal case shares a package with the dependency case
 *
 * `not-run` is a claim about ordering, and a report says it whether or not it
 * is true. The removal case runs against a package that *does* reach the
 * database package, and the case below it proves that same package fails gate
 * 4 when the run gets that far. So the `not-run` on gate 4 is not "there was
 * nothing to find" — there was, and the diff failure is why nobody looked.
 */

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

const diffFixture = (...segments: string[]): string => join(FIXTURES, 'diff', ...segments);

/** Lints clean against the house ruleset. `lint.test.ts` is what pins that. */
const SATISFYING_SPEC = join(FIXTURES, 'valid', 'satisfies-all-rules.yaml');

/** The baseline the two revisions below are revisions of. Also house-clean. */
const DIFF_BASE = diffFixture('base.yaml');
const ADDITIVE_REVISION = diffFixture('not-breaking', 'optional-response-property-added.yaml');
const REMOVAL_REVISION = diffFixture('breaking', 'response-required-property-removed.yaml');

/**
 * The one version the scratch packages publish. `latestPublishedSpec` accepts
 * `<major>.<minor>.<patch>.json` and nothing else, so the name is not free.
 */
const PUBLISHED_VERSION = '1.0.0.json';

interface ScratchPackageOptions {
  /** A YAML fixture to publish as this package's baseline. */
  publish?: string;
  /** Plant the type-only database import spec section 2.1 forbids. */
  reachesDb?: boolean;
}

let scratchRoot = '';

/**
 * Published, and reaching the database package. Built once and shared by the
 * two cases that differ only in the document under review — see the note on
 * `not-run` above.
 */
let dbReachingPackage = '';

/**
 * Writes a contract package the four gates can actually be pointed at: a
 * manifest for gate 4 to read, a source file for it to scan, and optionally a
 * published baseline for gate 3 to diff against.
 */
function createContractPackage(options: ScratchPackageOptions = {}): string {
  const dir = mkdtempSync(join(scratchRoot, 'contracts-fixture-'));

  const manifest = {
    name: '@marcos-corp/contracts-fixture',
    version: '1.0.0',
    private: true,
    dependencies: { '@sinclair/typebox': '^0.34.52' },
  };
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // Gate 4 scans source files, so there has to be one. A package with an empty
  // tree passes that gate for a reason that has nothing to do with the gate.
  const dbImport = options.reachesDb === true
    ? `import type { Card } from '${DB_PACKAGE_NAME}';\n\n`
    : '';
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'contract.ts'), `${dbImport}export const contract = {};\n`);

  if (options.publish !== undefined) {
    // The fixtures are YAML because each one carries the comment explaining
    // what it changes and why nothing else moves. A published baseline is
    // JSON, because that is what a contract package commits — the emitted
    // document. So the baseline is the fixture *converted*, never the fixture
    // copied under a `.json` name.
    const document: unknown = parseYaml(readFileSync(options.publish, 'utf8'));
    const publishedDir = join(dir, 'openapi', 'published');
    mkdirSync(publishedDir, { recursive: true });
    writeFileSync(join(publishedDir, PUBLISHED_VERSION), `${JSON.stringify(document, null, 2)}\n`);
  }

  return dir;
}

/** Every gate and its status, in report order — the two claims in one value. */
const gateStatuses = (report: GateReport): [GateName, GateStatus][] => report.outcomes
  .map((outcome): [GateName, GateStatus] => [outcome.gate, outcome.status]);

function outcomeFor(report: GateReport, gate: GateName): GateOutcome {
  const outcome = report.outcomes.find((candidate) => candidate.gate === gate);
  if (outcome === undefined) throw new Error(`the report carries no '${gate}' outcome`);
  return outcome;
}

const reasonsOf = (report: GateReport): string => (report.failure?.reasons ?? []).join('\n');

beforeAll(async () => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'contract-tooling-gates-'));
  dbReachingPackage = createContractPackage({ publish: DIFF_BASE, reachesDb: true });

  // vacuum and oasdiff are documented prerequisites, not something this suite
  // can install. Touching both up front turns an unprovisioned machine into
  // one pointed failure rather than a handful of lookalikes.
  await lintSpec(SATISFYING_SPEC);
  await diffSpecs(DIFF_BASE, DIFF_BASE);
});

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

describe('runGates, end to end against the committed fixtures', () => {
  it('publishes the baseline as the document the fixtures were written against', () => {
    const published = join(dbReachingPackage, 'openapi', 'published', PUBLISHED_VERSION);

    // A conversion that silently produced `{}` still reddens the removal case
    // below — oasdiff reads an empty baseline as every path *added*, which is
    // not breaking — but it reddens it for the wrong reason, and the suite
    // would then read as an indictment of the diff gate. This separates them.
    expect(JSON.parse(readFileSync(published, 'utf8')))
      .toEqual(parseYaml(readFileSync(DIFF_BASE, 'utf8')));
  });

  it('passes the satisfying fixture, and skips the gates that have nothing to do', async () => {
    const contractPackageDir = createContractPackage();

    const report = await runGates({ specPath: SATISFYING_SPEC, contractPackageDir });

    expect(report.ok).toBe(true);
    expect(report.failure).toBeNull();
    // Gate 1 was handed a document rather than a contract, and gate 3 has no
    // published baseline to read. Both are `skipped`, and neither is a quiet
    // `passed`: nothing here is evidence that either gate would have passed.
    expect(gateStatuses(report)).toEqual([
      ['emit', 'skipped'],
      ['lint', 'passed'],
      ['diff', 'skipped'],
      ['dependency', 'passed'],
    ]);
    expect(report.document).toBeNull();
    expect(outcomeFor(report, 'diff').summary).toContain('published no baseline yet');
  });

  it('passes every gate when the change against the published baseline is additive', async () => {
    const contractPackageDir = createContractPackage({ publish: DIFF_BASE });

    const report = await runGates({ specPath: ADDITIVE_REVISION, contractPackageDir });

    expect(report.ok).toBe(true);
    expect(report.failure).toBeNull();
    // The passing report the whole governance story rests on: a consumer team
    // added an optional response property to a contract, and all four gates
    // let it through. `diff` is `passed` here and `skipped` above, which is
    // what makes the removal case below a statement about the gate.
    expect(gateStatuses(report)).toEqual([
      ['emit', 'skipped'],
      ['lint', 'passed'],
      ['diff', 'passed'],
      ['dependency', 'passed'],
    ]);
    expect(outcomeFor(report, 'diff').summary).toContain(PUBLISHED_VERSION);
  });

  it('names the diff gate when the revision removes a required response field', async () => {
    const report = await runGates({
      specPath: REMOVAL_REVISION,
      contractPackageDir: dbReachingPackage,
    });

    expect(report.ok).toBe(false);
    expect(report.failure?.gate).toBe('diff');
    expect(outcomeFor(report, 'diff').summary).toContain(PUBLISHED_VERSION);
    // Spec section 9.2 asks for the removed field and the operation it breaks,
    // not just the verdict, so that a reviewer can act on the failure without
    // re-running the gate by hand.
    expect(reasonsOf(report)).toContain('response-required-property-removed');
    expect(reasonsOf(report)).toContain('lastFour');
    expect(reasonsOf(report)).toContain('getCompanyDashboard');
    expect(gateStatuses(report)).toEqual([
      ['emit', 'skipped'],
      ['lint', 'passed'],
      ['diff', 'failed'],
      ['dependency', 'not-run'],
    ]);
  });

  it('reaches the dependency gate on that same package when the diff gate passes', async () => {
    const report = await runGates({
      specPath: ADDITIVE_REVISION,
      contractPackageDir: dbReachingPackage,
    });

    // Same package as the case above, same baseline; only the document under
    // review changed. Gate 4 fails here, so the `not-run` above is the runner
    // stopping at the first failure rather than a package with nothing to find.
    expect(report.ok).toBe(false);
    expect(report.failure?.gate).toBe('dependency');
    expect(reasonsOf(report)).toContain(DB_PACKAGE_NAME);
    expect(reasonsOf(report)).toContain('src/contract.ts');
    expect(gateStatuses(report)).toEqual([
      ['emit', 'skipped'],
      ['lint', 'passed'],
      ['diff', 'passed'],
      ['dependency', 'failed'],
    ]);
  });
});
