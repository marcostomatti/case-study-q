import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HOUSE_RULESET_PATH, lintSpec, SPEC_PARSE_FAILED } from './lint';

/**
 * These are the tests that make the house ruleset more than decoration. A
 * ruleset that loads and reports nothing looks exactly like a correct one, so
 * every rule is paired with a document that must fail on it and on no other,
 * and the whole set is paired with one document that must fail on nothing.
 * The contract between this suite and `../fixtures/` is written down in
 * `../fixtures/README.md`; the two closure tests below are what keep the two
 * from drifting apart in silence.
 *
 * They shell out to the real `vacuum` binary rather than to a stub. A stubbed
 * vacuum would prove this file parses its own fixtures, which is not the
 * claim — the claim is that these rules fire on these documents.
 */

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));
const VIOLATIONS_DIR = join(FIXTURES_DIR, 'violations');
const VALID_SPEC = join(FIXTURES_DIR, 'valid', 'satisfies-all-rules.yaml');

const violationFixtures = readdirSync(VIOLATIONS_DIR)
  .filter((name) => name.endsWith('.yaml'))
  .sort();

/**
 * The expected rule code is the filename up to its first `.`, so this suite
 * derives its expectations instead of carrying a table that goes stale the
 * moment a rule is added. The optional `.<leg>` segment names which `then`
 * entry the document exercises and is not part of the code.
 */
const expectedCode = (fixture: string): string => fixture.split('.')[0] ?? '';

/**
 * Rule ids are the only keys at two-space indentation in the ruleset; every
 * key a rule owns (`description`, `severity`, `given`, `then`) sits at four
 * or more. Parsing this with a regex instead of a YAML library keeps the
 * package dependency-free, and the extractor is itself checked below — an
 * extractor that quietly returns nothing would make both closure tests pass
 * vacuously.
 */
const rulesetRuleIds = (): string[] => {
  const source = readFileSync(HOUSE_RULESET_PATH, 'utf8');
  return [...source.matchAll(/^ {2}([A-Za-z][A-Za-z0-9-]*):[ \t]*$/gm)]
    .map((match) => match[1] ?? '');
};

let scratchDir = '';

beforeAll(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), 'contract-tooling-lint-'));
  // One pointed failure beats twelve identical ones. vacuum is a documented
  // prerequisite, not something this suite can install.
  await lintSpec(VALID_SPEC);
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('the house ruleset, against its fixtures', () => {
  it('has fixtures to run at all', () => {
    // `it.each([])` registers no tests and reports success, so an empty or
    // mis-resolved fixtures directory would make every case below disappear
    // without a single red line.
    expect(violationFixtures.length).toBeGreaterThan(0);
  });

  it.each(violationFixtures)('%s fails on its own rule and no other', async (fixture) => {
    const result = await lintSpec(join(VIOLATIONS_DIR, fixture));

    expect(result.ok).toBe(false);
    // The code SET, never a finding count: vacuum resolves `$ref` before a
    // rule runs, so one violation on a referenced schema is reported twice —
    // once at its real path and once at the resolved copy. `toHaveLength(1)`
    // is flaky by construction here.
    expect([...new Set(result.errors.map((finding) => finding.code))])
      .toEqual([expectedCode(fixture)]);
  });

  it('reports nothing against the document that satisfies every rule', async () => {
    const result = await lintSpec(VALID_SPEC);

    expect(result.findings).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('ruleset and fixture closure', () => {
  it('extracts the rule ids and nothing else', () => {
    const ids = rulesetRuleIds();

    expect(ids.length).toBeGreaterThan(0);
    // The negative control. If the indentation assumption ever breaks, the
    // keys that leak in are these, and both closure tests below would then
    // pass or fail for reasons that have nothing to do with coverage.
    expect(ids).not.toContain('description');
    expect(ids).not.toContain('severity');
    expect(ids).not.toContain('given');
    expect(ids).not.toContain('then');
    expect(ids.every((id) => id.startsWith('house-'))).toBe(true);
  });

  it('has at least one violating fixture for every rule in the ruleset', () => {
    const covered = new Set(violationFixtures.map(expectedCode));
    const uncovered = rulesetRuleIds().filter((id) => !covered.has(id));

    // A rule with no fixture is coverage that reads as present and is not.
    expect(uncovered).toEqual([]);
  });

  it('has no fixture naming a rule the ruleset does not define', () => {
    const defined = new Set(rulesetRuleIds());
    const orphaned = violationFixtures.filter((f) => !defined.has(expectedCode(f)));

    // A fixture whose name no longer matches a renamed rule still passes its
    // own assertion, because it is asserted against its own filename.
    expect(orphaned).toEqual([]);
  });
});

describe('the parsed finding', () => {
  it('carries the path, message and line vacuum reported', async () => {
    const result = await lintSpec(join(VIOLATIONS_DIR, 'house-enum-has-unknown-member.yaml'));
    const [finding] = result.errors;

    expect(finding).toBeDefined();
    expect(finding?.code).toBe('house-enum-has-unknown-member');
    expect(finding?.path).toEqual(['components', 'schemas', 'CardState']);
    expect(finding?.severity).toBe('error');
    // vacuum does not interpolate `message:`, so reported text is
    // "<description>: <function message>" — the rule's own description is the
    // first half and is what makes the finding readable.
    expect(finding?.message).toContain('unknown member');
    // The field to point a human at: correct even where vacuum cannot render
    // a path and prints the raw filter instead.
    expect(finding?.line).toBeGreaterThan(0);
  });

  it('keeps a warn-severity finding out of `errors` without dropping it', async () => {
    const rulesetPath = join(scratchDir, 'warn.spectral.yaml');
    writeFileSync(rulesetPath, [
      'rules:',
      '  probe-warn-severity:',
      '    description: fires on info so the severity mapping has a non-error finding',
      '    severity: warn',
      '    given: $.info',
      '    then:',
      '      field: x-not-present',
      '      function: defined',
      '',
    ].join('\n'));

    const result = await lintSpec(VALID_SPEC, { rulesetPath });

    // Without this split a warn-severity rule would either block CI or vanish
    // from the report; both are silent, and the second is the worse one.
    expect(result.findings.map((finding) => finding.severity)).toEqual(['warn']);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('outcomes a wrapper must not mistake for a pass', () => {
  it('reports an unparseable document as a finding naming that document', async () => {
    // vacuum exits 2 here and writes an ANSI-coloured banner to STDOUT, so a
    // wrapper that only ever calls JSON.parse(stdout) throws an error that
    // does not name the spec.
    const specPath = join(scratchDir, 'unparseable.yaml');
    writeFileSync(specPath, 'openapi: 3.1.0\npaths:\n  - [\n');

    const result = await lintSpec(specPath);

    expect(result.ok).toBe(false);
    expect(result.errors.map((finding) => finding.code)).toEqual([SPEC_PARSE_FAILED]);
    expect(result.errors[0]?.message).toContain(specPath);
  });

  it('throws rather than passing when the spec does not exist', async () => {
    const missing = join(scratchDir, 'no-such-spec.yaml');

    await expect(lintSpec(missing)).rejects.toThrow(missing);
  });

  it('throws rather than passing when the ruleset does not exist', async () => {
    const missing = join(scratchDir, 'no-such-ruleset.yaml');

    await expect(lintSpec(VALID_SPEC, { rulesetPath: missing })).rejects.toThrow(missing);
  });

  it('throws naming the prerequisite when vacuum is not on PATH', async () => {
    // The failure that would otherwise read as "no findings, all clear".
    await expect(lintSpec(VALID_SPEC, { vacuumBin: join(scratchDir, 'not-vacuum') }))
      .rejects.toThrow(/could not execute/);
  });
});
