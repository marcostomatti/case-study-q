import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { diffSpecs } from './diff';

/**
 * These are the tests that make the diff gate more than a subprocess call.
 * `oasdiff breaking` exits 0 whether or not it found anything, so a wrapper
 * that reads the exit code and a wrapper that works are indistinguishable
 * until something is asserted about the report itself.
 *
 * The fixtures are committed revisions of one committed baseline, described
 * in `../fixtures/diff/README.md`. Every revision under `breaking/` must
 * report the change id its filename names and no other; every revision under
 * `not-breaking/` must report nothing while still differing from the base.
 * That last clause is load-bearing — a revision identical to the baseline
 * reports nothing for a reason that has nothing to do with the gate.
 *
 * They shell out to the real `oasdiff` binary rather than to a stub, for the
 * same reason `lint.test.ts` shells out to the real vacuum: a stub would
 * prove this file parses its own fixtures, not that oasdiff classifies these
 * edits the way the governance story claims it does.
 */

const DIFF_DIR = fileURLToPath(new URL('../fixtures/diff/', import.meta.url));
const BASE_SPEC = join(DIFF_DIR, 'base.yaml');
const BREAKING_DIR = join(DIFF_DIR, 'breaking');
const NOT_BREAKING_DIR = join(DIFF_DIR, 'not-breaking');

const yamlIn = (dir: string): string[] => readdirSync(dir)
  .filter((name) => name.endsWith('.yaml'))
  .sort();

const breakingFixtures = yamlIn(BREAKING_DIR);
const notBreakingFixtures = yamlIn(NOT_BREAKING_DIR);

/**
 * The expected oasdiff change id is the filename up to its first `.`, the
 * same convention `../fixtures/violations/` uses for house rule codes. The
 * suite derives its expectations rather than carrying a table that drifts as
 * cases are added.
 */
const expectedId = (fixture: string): string => fixture.split('.')[0] ?? '';

const idsIn = (changes: readonly { id: string }[]): string[] => [
  ...new Set(changes.map((change) => change.id)),
].sort();

let scratchDir = '';

beforeAll(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), 'contract-tooling-diff-'));
  // One pointed failure beats a dozen identical ones. oasdiff is a documented
  // prerequisite, not something this suite can install.
  await diffSpecs(BASE_SPEC, BASE_SPEC);
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('the diff gate, against its fixtures', () => {
  it('has fixtures of both kinds to run at all', () => {
    // `it.each([])` registers no tests and reports success, so an empty or
    // mis-resolved fixtures directory would make every case below disappear
    // without a single red line.
    expect(breakingFixtures.length).toBeGreaterThan(0);
    expect(notBreakingFixtures.length).toBeGreaterThan(0);
  });

  it.each([...breakingFixtures, ...notBreakingFixtures])(
    '%s is a real revision of the baseline',
    (fixture) => {
      const dir = breakingFixtures.includes(fixture)
        ? BREAKING_DIR
        : NOT_BREAKING_DIR;

      // Without this, a not-breaking fixture that was never edited passes its
      // own assertion for entirely the wrong reason: no diff, no findings.
      expect(readFileSync(join(dir, fixture), 'utf8'))
        .not.toEqual(readFileSync(BASE_SPEC, 'utf8'));
    },
  );

  it.each(breakingFixtures)('%s breaks on its own change id and no other', async (fixture) => {
    const result = await diffSpecs(BASE_SPEC, join(BREAKING_DIR, fixture));

    expect(result.breaking).toBe(true);
    expect(idsIn(result.changes)).toEqual([expectedId(fixture)]);
  });

  it.each(notBreakingFixtures)('%s reports no breaking change', async (fixture) => {
    const result = await diffSpecs(BASE_SPEC, join(NOT_BREAKING_DIR, fixture));

    expect(result.changes).toEqual([]);
    expect(result.breaking).toBe(false);
  });

  it('reports nothing when the revision is the baseline', async () => {
    const result = await diffSpecs(BASE_SPEC, BASE_SPEC);

    expect(result).toEqual({ breaking: false, changes: [] });
  });
});

describe('the three changes spec section 6.1 turns on', () => {
  it('lets an added optional response property through', async () => {
    // Spec 9.1: the consumer-authored additive field that the mock serves
    // before any handler exists. If this reported breaking, the whole
    // unblocking workflow would be gated on a provider deploy.
    const result = await diffSpecs(
      BASE_SPEC,
      join(NOT_BREAKING_DIR, 'optional-response-property-added.yaml'),
    );

    expect(result.breaking).toBe(false);
  });

  it('blocks a removed required response field, naming the field and the operation', async () => {
    // Spec 9.2: the removal must be blocked with a message a human can act
    // on. A boolean alone would satisfy the gate and not the acceptance
    // criterion, which asks for the field and the operation it breaks.
    const result = await diffSpecs(
      BASE_SPEC,
      join(BREAKING_DIR, 'response-required-property-removed.yaml'),
    );
    const [change] = result.changes;

    expect(result.breaking).toBe(true);
    expect(change?.id).toBe('response-required-property-removed');
    expect(change?.level).toBe('error');
    expect(change?.text).toContain('lastFour');
    expect(change?.operationId).toBe('getCompanyDashboard');
    expect(change?.operation).toBe('GET');
    expect(change?.path).toBe('/companies/{companyId}/dashboard');
    // The baseline is where the removed field still exists, so that is the
    // side with a line to send a reviewer to.
    expect(change?.base?.file).toBe(BASE_SPEC);
    expect(change?.base?.line).toBeGreaterThan(0);
  });

  it('blocks a narrowed request property type', async () => {
    const result = await diffSpecs(
      BASE_SPEC,
      join(BREAKING_DIR, 'request-property-type-changed.yaml'),
    );
    const [change] = result.changes;

    expect(result.breaking).toBe(true);
    expect(change?.id).toBe('request-property-type-changed');
    expect(change?.level).toBe('error');
    expect(change?.text).toContain('number');
    expect(change?.text).toContain('integer');
    expect(change?.operationId).toBe('replaceSpendLimit');
    // A type change exists on both sides, so both locations are populated.
    expect(change?.base?.file).toBe(BASE_SPEC);
    expect(change?.revision?.file).toContain('request-property-type-changed.yaml');
  });

  it('does not report the same narrowing applied to a response property', async () => {
    // The asymmetry the narrowing fixture depends on, pinned rather than
    // trusted: tightening what the provider EMITS is safe, tightening what it
    // ACCEPTS is not. Get this backwards and the breaking fixture above would
    // have been written against SpendLimit and would never have fired.
    const revisionPath = join(scratchDir, 'response-narrowed.yaml');
    const source = readFileSync(BASE_SPEC, 'utf8');
    const narrowed = source.replace(
      `    SpendLimit:
      type: object
      additionalProperties: false
      required: [minorUnits, currency]
      properties:
        minorUnits:
          type: integer`,
      `    SpendLimit:
      type: object
      additionalProperties: false
      required: [minorUnits, currency]
      properties:
        minorUnits:
          type: number`,
    );
    // The line that separates a mutation from a search string that missed.
    expect(narrowed).not.toEqual(source);
    // Written base-first so the narrowing runs number -> integer, matching
    // the direction of the request-side fixture.
    writeFileSync(revisionPath, narrowed);

    const result = await diffSpecs(revisionPath, BASE_SPEC);

    expect(result.changes).toEqual([]);
    expect(result.breaking).toBe(false);
  });
});

describe('outcomes a wrapper must not mistake for a pass', () => {
  it('exits 0 from oasdiff even when the change is breaking', async () => {
    // The trap this module exists to avoid, asserted directly rather than
    // left as a comment: pass/fail comes from the parsed report, so a gate
    // built on the exit code would let every removal through.
    const result = await diffSpecs(
      BASE_SPEC,
      join(BREAKING_DIR, 'response-required-property-removed.yaml'),
    );

    expect(result.breaking).toBe(true);
  });

  it('throws saying which SIDE is missing, not just which path', async () => {
    // Deleting the existsSync pre-check leaves both of these passing on a
    // path match alone, because oasdiff names the file too. The wording is
    // the whole contribution of the pre-check: oasdiff reports a missing file
    // and an unparseable one with one exit code, so "which side" would
    // otherwise have to be recovered from its message text.
    const missingBase = join(scratchDir, 'no-such-base.yaml');
    const missingRevision = join(scratchDir, 'no-such-revision.yaml');

    await expect(diffSpecs(missingBase, BASE_SPEC))
      .rejects.toThrow(`diff gate cannot run: base spec not found at '${missingBase}'`);
    await expect(diffSpecs(BASE_SPEC, missingRevision))
      .rejects.toThrow(`diff gate cannot run: revision spec not found at '${missingRevision}'`);
  });

  it('throws rather than passing when the revision does not parse', async () => {
    // oasdiff exits 102 and names the file on stderr. Returning "no breaking
    // changes" here would publish an unparseable contract.
    const specPath = join(scratchDir, 'unparseable.yaml');
    writeFileSync(specPath, 'openapi: 3.0.3\npaths:\n  - [\n');

    const rejection = expect(diffSpecs(BASE_SPEC, specPath)).rejects;

    await rejection.toThrow(new RegExp(`diff gate cannot run.*${basename(specPath)}`, 's'));
    // oasdiff's own explanation, which only reaches the message through the
    // exit-code branch. Without it, deleting that branch still throws — from
    // JSON.parse on the empty stdout — and this case cannot tell the two
    // apart.
    await rejection.toThrow(/failed to load/);
  });

  it('throws naming the prerequisite when oasdiff is not on PATH', async () => {
    // The failure that would otherwise read as "no breaking changes found".
    await expect(diffSpecs(BASE_SPEC, BASE_SPEC, { oasdiffBin: join(scratchDir, 'not-oasdiff') }))
      .rejects.toThrow(/could not execute/);
  });

  it('reports a document that parses but describes no API as maximally breaking', async () => {
    // Valid YAML, not an OpenAPI description. oasdiff does not reject it — it
    // reads every path as removed. That fails in the safe direction, and it
    // is why gate order in spec section 8 puts emit and lint first.
    const specPath = join(scratchDir, 'not-an-api.yaml');
    writeFileSync(specPath, 'openapi: 3.0.3\ninfo:\n  title: Empty\n  version: 1.0.0\npaths: {}\n');

    const result = await diffSpecs(BASE_SPEC, specPath);

    expect(result.breaking).toBe(true);
    expect(idsIn(result.changes)).toEqual(['api-path-removed-without-deprecation']);
  });
});
