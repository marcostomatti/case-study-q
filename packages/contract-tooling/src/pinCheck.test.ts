import type { PinFinding, PinViolationReason } from './pinCheck';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertExactContractPins, CONTRACT_PACKAGE_PREFIX } from './pinCheck';

/**
 * Spec section 2.2: a consumer depends on
 * `"@marcos-corp/contracts-service-a": "3.2.1"`. No caret, no tilde. The
 * friction is the point — adopting a new contract version has to be a reviewed
 * pull request, because that pull request is the record of which consumer runs
 * against which contract version.
 *
 * Two failure modes shape the cases below, and both leave a green gate:
 *
 *   1. **A specifier form the check does not recognise.** A gate looking for
 *      `^` and `~` waves through `*`, `0.1.x`, `latest`, `>=0.1.0` and
 *      `workspace:*`, every one of which floats the consumer onto a contract
 *      version nobody reviewed. So the check is default-deny — exactly a
 *      version passes, everything else is a finding — and each shape that a
 *      package manager accepts gets its own case.
 *   2. **A gate that read nothing.** A consumer with no contract dependency and
 *      one whose manifest was never opened report the same empty list, so every
 *      case asserting emptiness plants a ranged pin into that same manifest
 *      afterwards and asserts it is now reported.
 *
 * The tolerance cases carry as much weight as the violations. A caret on
 * `express` is ordinary and correct, and so is one on
 * `@marcos-corp/contract-tooling` — a package name one character away from the
 * prefix this gate matches on.
 */

let scratchRoot = '';

beforeAll(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'contract-tooling-pin-'));
});

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

const CONTRACTS_SERVICE_A = `${CONTRACT_PACKAGE_PREFIX}service-a`;
const CONTRACTS_SERVICE_B = `${CONTRACT_PACKAGE_PREFIX}service-b`;

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/**
 * Dependencies a consumer in this repo legitimately carries alongside its
 * contract pins, every one of them ranged on purpose. They sit in every
 * scratch manifest, so each case below doubles as the assertion that the gate
 * governs contract packages only, and a "no findings" result is a statement
 * about a manifest with dependencies in it rather than about an empty one.
 *
 * `@marcos-corp/contract-tooling` is the near miss worth keeping: singular
 * `contract-`, so a prefix check written one character short reports it.
 */
const UNGOVERNED_DEPENDENCIES = {
  '@marcos-corp/contract-tooling': '^0.1.0',
  '@marcos-corp/db': '^0.1.0',
  '@sinclair/typebox': '^0.34.0',
  express: '^4.22.2',
};

interface ConsumerSpec {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const writeManifest = (packageDir: string, manifest: unknown): void => {
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
};

const consumerPackage = (spec: ConsumerSpec = {}): string => {
  const packageDir = mkdtempSync(join(scratchRoot, 'consumer-'));
  writeManifest(packageDir, {
    name: '@marcos-corp/web-scratch',
    version: '0.1.0',
    private: true,
    ...spec,
    dependencies: { ...UNGOVERNED_DEPENDENCIES, ...spec.dependencies },
  });
  return packageDir;
};

const packageNames = (findings: readonly PinFinding[]): string[] => findings
  .map((finding) => finding.packageName);

/**
 * The positive control every emptiness assertion is paired with. Without it a
 * case passes just as convincingly against a check that reads the wrong
 * manifest, or one that returns nothing unconditionally.
 */
const provePlantedRangeIsFound = (packageDir: string): void => {
  const manifest = JSON.parse(
    readFileSync(join(packageDir, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };

  writeManifest(packageDir, {
    ...manifest,
    dependencies: { ...manifest.dependencies, [CONTRACTS_SERVICE_B]: '^9.9.9' },
  });

  expect(packageNames(assertExactContractPins(packageDir))).toContain(CONTRACTS_SERVICE_B);
};

describe('a consumer that pins every contract package exactly', () => {
  it('has no findings, and the same manifest reports a planted range', () => {
    const packageDir = consumerPackage({
      dependencies: { [CONTRACTS_SERVICE_A]: '0.1.0', [CONTRACTS_SERVICE_B]: '1.10.3' },
    });

    expect(assertExactContractPins(packageDir)).toEqual([]);

    provePlantedRangeIsFound(packageDir);
  });

  it('accepts an exact prerelease version, which names one version like any other', () => {
    const packageDir = consumerPackage({
      dependencies: { [CONTRACTS_SERVICE_A]: '1.0.0-rc.1' },
    });

    expect(assertExactContractPins(packageDir)).toEqual([]);

    provePlantedRangeIsFound(packageDir);
  });

  it.each(DEPENDENCY_FIELDS)('accepts an exact pin in %s', (field) => {
    const packageDir = consumerPackage({ [field]: { [CONTRACTS_SERVICE_A]: '0.1.0' } });

    expect(assertExactContractPins(packageDir)).toEqual([]);

    provePlantedRangeIsFound(packageDir);
  });
});

describe('dependencies this rule does not govern', () => {
  it('leaves a consumer with no contract dependency alone', () => {
    const packageDir = consumerPackage();

    // Every dependency in the baseline manifest is ranged, and every one of
    // them is somebody else's package. Spec section 2.2 is about contract
    // packages; a caret on express is ordinary and correct.
    expect(assertExactContractPins(packageDir)).toEqual([]);

    provePlantedRangeIsFound(packageDir);
  });

  it('does not report @marcos-corp/contract-tooling, which is not a contract package', () => {
    const packageDir = consumerPackage({
      dependencies: { '@marcos-corp/contract-tooling': 'workspace:*' },
    });

    // Singular `contract-`, so it is one character short of the governed
    // prefix. A check matching on `@marcos-corp/contract` reports it.
    expect(assertExactContractPins(packageDir)).toEqual([]);

    provePlantedRangeIsFound(packageDir);
  });
});

describe('a contract dependency that is not pinned to an exact version', () => {
  /**
   * Every specifier form a package manager accepts and this gate must refuse,
   * with the reason it is refused for. The reason is asserted, not just the
   * refusal: `workspace:*` and `^0.1.0` fail the same rule for different
   * causes, and a report that cannot tell them apart cannot tell a consumer
   * what to write instead.
   */
  const rangedSpecifiers: ReadonlyArray<readonly [string, PinViolationReason]> = [
    ['^0.1.0', 'range'],
    ['~0.1.0', 'range'],
    ['>=0.1.0', 'range'],
    ['=0.1.0', 'range'],
    ['>0.1.0 <1.0.0', 'range'],
    ['0.1.0 || 0.2.0', 'range'],
    ['0.1.0 - 0.2.0', 'range'],
    ['*', 'wildcard'],
    ['x', 'wildcard'],
    ['0.1.x', 'wildcard'],
    ['0.1', 'wildcard'],
    ['', 'wildcard'],
    ['workspace:*', 'workspace-protocol'],
    ['workspace:^0.1.0', 'workspace-protocol'],
    ['workspace:0.1.0', 'workspace-protocol'],
    ['latest', 'not-a-version'],
    ['file:../contracts-service-a', 'not-a-version'],
    ['npm:@marcos-corp/contracts-service-a@0.1.0', 'not-a-version'],
  ];

  it.each(rangedSpecifiers)('reports %j as %s', (specifier, reason) => {
    const packageDir = consumerPackage({
      dependencies: { [CONTRACTS_SERVICE_A]: specifier },
    });

    const findings = assertExactContractPins(packageDir);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'package.json',
      field: 'dependencies',
      packageName: CONTRACTS_SERVICE_A,
      specifier,
      reason,
    });
  });

  it.each(DEPENDENCY_FIELDS)('reports a caret in %s', (field) => {
    const packageDir = consumerPackage({ [field]: { [CONTRACTS_SERVICE_A]: '^0.1.0' } });

    const findings = assertExactContractPins(packageDir);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ field, packageName: CONTRACTS_SERVICE_A });
  });

  it('names the package, the field and the specifier in the message', () => {
    const packageDir = consumerPackage({
      dependencies: { [CONTRACTS_SERVICE_A]: '~0.1.0' },
    });

    // The CI pins job prints these and nothing else, so the message has to be
    // enough on its own to find the line and know what to replace it with.
    const [finding] = assertExactContractPins(packageDir);

    expect(finding?.message).toContain(CONTRACTS_SERVICE_A);
    expect(finding?.message).toContain('dependencies');
    expect(finding?.message).toContain('~0.1.0');
  });

  it('reports every ranged contract pin, not only the first', () => {
    const packageDir = consumerPackage({
      dependencies: { [CONTRACTS_SERVICE_B]: 'workspace:*', [CONTRACTS_SERVICE_A]: '^0.1.0' },
    });

    const findings = assertExactContractPins(packageDir);

    expect(findings).toHaveLength(2);
    // Sorted by package name rather than left in manifest order, so two
    // consumers declaring the same pins produce the same report.
    expect(packageNames(findings)).toEqual([CONTRACTS_SERVICE_A, CONTRACTS_SERVICE_B]);
  });

  it('reports the same package ranged in two fields', () => {
    const packageDir = consumerPackage({
      dependencies: { [CONTRACTS_SERVICE_A]: '^0.1.0' },
      peerDependencies: { [CONTRACTS_SERVICE_A]: '^0.1.0' },
    });

    const findings = assertExactContractPins(packageDir);

    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.field)).toEqual([
      'dependencies',
      'peerDependencies',
    ]);
  });

  it('reports the ranged pin and leaves the exact one alone in the same manifest', () => {
    const packageDir = consumerPackage({
      dependencies: { [CONTRACTS_SERVICE_A]: '0.1.0', [CONTRACTS_SERVICE_B]: '^0.1.0' },
    });

    expect(assertExactContractPins(packageDir)).toMatchObject([
      { packageName: CONTRACTS_SERVICE_B, specifier: '^0.1.0' },
    ]);
  });
});

describe('checks that must fail loudly rather than report a clean manifest', () => {
  /**
   * Each case asserts the `cannot run` wording as well as the offending path.
   * A bare filesystem error names the path too, so without it these pass
   * against a check that merely lets an ENOENT escape — which reaches a caller
   * as a crash rather than as the one thing it has to say: the gate did not
   * run, so this consumer's pins are unproven.
   */
  const cannotRun = /pin gate cannot run/;

  it('throws when the package directory does not exist', () => {
    const missing = join(scratchRoot, 'consumer-nonexistent');

    expect(() => assertExactContractPins(missing)).toThrow(missing);
    expect(() => assertExactContractPins(missing)).toThrow(cannotRun);
  });

  it('throws when the package has no manifest', () => {
    const packageDir = mkdtempSync(join(scratchRoot, 'consumer-'));

    // Returning no findings here would read as "this consumer pins correctly"
    // for a directory that is not a package at all.
    expect(() => assertExactContractPins(packageDir)).toThrow(/package\.json/);
    expect(() => assertExactContractPins(packageDir)).toThrow(cannotRun);
  });

  it('throws when the manifest does not parse', () => {
    const packageDir = consumerPackage();
    writeFileSync(join(packageDir, 'package.json'), '{ "name": "@marcos-corp/web-scratch",\n');

    expect(() => assertExactContractPins(packageDir)).toThrow(/package\.json/);
    expect(() => assertExactContractPins(packageDir)).toThrow(cannotRun);
  });

  it('throws when a dependency field is not a map of package name to version', () => {
    const packageDir = mkdtempSync(join(scratchRoot, 'consumer-'));
    writeManifest(packageDir, { name: '@marcos-corp/web-scratch', dependencies: [] });

    expect(() => assertExactContractPins(packageDir)).toThrow(/dependencies/);
    expect(() => assertExactContractPins(packageDir)).toThrow(cannotRun);
  });

  it('throws when a contract pin is not a string', () => {
    const packageDir = mkdtempSync(join(scratchRoot, 'consumer-'));
    writeManifest(packageDir, {
      name: '@marcos-corp/web-scratch',
      dependencies: { [CONTRACTS_SERVICE_A]: 1 },
    });

    expect(() => assertExactContractPins(packageDir)).toThrow(CONTRACTS_SERVICE_A);
    expect(() => assertExactContractPins(packageDir)).toThrow(cannotRun);
  });
});
