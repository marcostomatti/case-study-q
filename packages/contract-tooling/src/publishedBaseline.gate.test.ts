import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { latestPublishedSpec } from './publishedBaseline';

/**
 * Every failure this resolver can have is silent by construction. It picks the
 * document gate 3 diffs against, and picking the wrong one does not error:
 * oasdiff still runs, still exits 0, and still reports "no breaking changes" —
 * against a baseline nobody published. So the cases below assert which file
 * came back, not merely that one did.
 *
 * The `1.9.0` / `1.10.0` pair is the reason a filename sort is not good
 * enough, and the case that uses it pins the trap rather than describing it.
 */

let scratchRoot = '';

beforeAll(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'contract-tooling-baseline-'));
});

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

/**
 * A stand-in for a published OpenAPI document. Only the filename matters to
 * the resolver; the body exists so one case can read the returned path back
 * and confirm it names the version it claims.
 */
const documentFor = (version: string): string => `${JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'contract-tooling baseline fixture', version },
  paths: {},
}, null, 2)}\n`;

/**
 * `openapi/published` is spelled out literally here rather than imported from
 * the module under test. A helper that asked the resolver where baselines live
 * would agree with it whatever it answered, and the documented location is
 * half of what these cases are pinning.
 */
const publish = (packageDir: string, fileNames: readonly string[]): void => {
  const publishedDir = join(packageDir, 'openapi', 'published');
  mkdirSync(publishedDir, { recursive: true });
  fileNames.forEach((name) => {
    writeFileSync(join(publishedDir, name), documentFor(name.replace(/\.json$/, '')));
  });
};

/** A contract package that has never published anything at all. */
const unpublishedContractPackage = (): string => mkdtempSync(join(scratchRoot, 'contracts-'));

const contractPackage = (fileNames: readonly string[]): string => {
  const packageDir = unpublishedContractPackage();
  publish(packageDir, fileNames);
  return packageDir;
};

const baselineIn = (packageDir: string, fileName: string): string => join(
  packageDir,
  'openapi',
  'published',
  fileName,
);

describe('the published baseline of a contract package', () => {
  it('is null when openapi/published exists but holds nothing', () => {
    const packageDir = contractPackage([]);

    expect(latestPublishedSpec(packageDir)).toBeNull();

    // The positive control. Without it this case passes just as convincingly
    // against a resolver that reads the wrong directory, or one that returns
    // null unconditionally.
    publish(packageDir, ['0.1.0.json']);
    expect(latestPublishedSpec(packageDir)).toBe(baselineIn(packageDir, '0.1.0.json'));
  });

  it('is null when the package has no openapi/published directory yet', () => {
    // The state every contract package is in before its first publish, and the
    // one gate 3 has to treat as "nothing to diff against" rather than as a
    // failure.
    const packageDir = unpublishedContractPackage();

    expect(latestPublishedSpec(packageDir)).toBeNull();

    publish(packageDir, ['0.1.0.json']);
    expect(latestPublishedSpec(packageDir)).toBe(baselineIn(packageDir, '0.1.0.json'));
  });

  it('is the sole document when exactly one version is published', () => {
    const packageDir = contractPackage(['0.1.0.json']);

    expect(latestPublishedSpec(packageDir)).toBe(baselineIn(packageDir, '0.1.0.json'));
  });

  it('orders 1.10.0 above 1.9.0, which a filename sort gets backwards', () => {
    const published = ['1.9.0.json', '1.10.0.json'];
    const packageDir = contractPackage(published);

    // Pins that this pair exercises the trap rather than merely describing it:
    // sorted as strings, `1.9.0.json` is the last entry, so a resolver built on
    // a filename sort hands every later diff the wrong baseline.
    expect([...published].sort().at(-1)).toBe('1.9.0.json');

    expect(latestPublishedSpec(packageDir)).toBe(baselineIn(packageDir, '1.10.0.json'));
  });

  it('orders on major and on patch, not only on minor', () => {
    const majors = contractPackage(['0.9.0.json', '1.10.0.json', '2.0.0.json']);
    expect(latestPublishedSpec(majors)).toBe(baselineIn(majors, '2.0.0.json'));

    const patches = contractPackage(['1.0.9.json', '1.0.10.json']);
    expect(latestPublishedSpec(patches)).toBe(baselineIn(patches, '1.0.10.json'));
  });

  it('returns a path that reads back as the version it names', () => {
    const packageDir = contractPackage(['1.9.0.json', '1.10.0.json']);

    const baseline = latestPublishedSpec(packageDir);
    if (baseline === null) throw new Error('no baseline resolved; the assertions below cannot run');

    // A path is not a document. Reading it is what separates "assembled the
    // right string" from "named a file that is actually there to diff against".
    expect(JSON.parse(readFileSync(baseline, 'utf8'))).toMatchObject({
      info: { version: '1.10.0' },
    });
  });

  it('resolves a relative package directory to an absolute path', () => {
    const packageDir = contractPackage(['1.0.0.json']);

    const baseline = latestPublishedSpec(relative(process.cwd(), packageDir));

    // `diffSpecs` hands this straight to oasdiff and the CI publish step writes
    // alongside it; neither should depend on the caller's working directory.
    expect(baseline).not.toBeNull();
    expect(isAbsolute(baseline ?? '')).toBe(true);
    expect(baseline).toBe(baselineIn(packageDir, '1.0.0.json'));
  });

  it('ignores files under openapi/published that are not documents', () => {
    const packageDir = contractPackage(['1.0.0.json']);
    writeFileSync(join(packageDir, 'openapi', 'published', 'README.md'), '# baselines\n');

    expect(latestPublishedSpec(packageDir)).toBe(baselineIn(packageDir, '1.0.0.json'));
  });
});

describe('lookups that must fail loudly rather than resolve to a wrong baseline', () => {
  it.each(['v1.10.0.json', '1.10.json', '01.2.0.json', '1.10.0-rc.1.json'])(
    'refuses to guess past %s',
    (fileName) => {
      // Skipping the file quietly is the dangerous reading: the resolver would
      // return 1.9.0 and the diff gate would report "no breaking changes"
      // against a baseline nobody published.
      const packageDir = contractPackage(['1.9.0.json', fileName]);

      expect(() => latestPublishedSpec(packageDir)).toThrow(fileName);
      expect(() => latestPublishedSpec(packageDir)).toThrow(/major.*minor.*patch/);
    },
  );

  it('throws when the contract package directory does not exist', () => {
    // A typo'd package directory returning null would disable the diff gate
    // for that package and read as "nothing published yet".
    const missing = join(scratchRoot, 'contracts-nonexistent');

    expect(() => latestPublishedSpec(missing)).toThrow(missing);
    expect(() => latestPublishedSpec(missing)).toThrow(/not found/);
  });

  it('throws when the contract package path is a file', () => {
    const notADirectory = join(scratchRoot, 'contracts-not-a-directory');
    writeFileSync(notADirectory, '');

    expect(() => latestPublishedSpec(notADirectory)).toThrow(notADirectory);
  });
});
