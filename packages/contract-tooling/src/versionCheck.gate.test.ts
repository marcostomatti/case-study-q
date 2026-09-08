/**
 * The version-bump gate, against a contract package built in a temp directory.
 *
 * Named `.gate.test.ts` rather than `.test.ts` so it runs under
 * `bun run test:gates` and not under `bun run test`. It shells out to nothing
 * itself, but it belongs with the gates conceptually and the naming is what
 * keeps the hygiene suite's scope legible.
 *
 * The clean case is not decoration. Every other case here asserts a REFUSAL,
 * and a gate that refuses everything satisfies all of them — including a gate
 * broken badly enough to reject an unchanged contract.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertVersionBumped, publishedBaselinePath } from './versionCheck';

const PACKAGE_NAME = '@marcos-corp/contracts-service-x';

let packageDir: string;

/** A document body; the gate compares bytes, so the shape is irrelevant. */
const DOCUMENT_V1 = '{"openapi":"3.1.0","paths":{}}';
const DOCUMENT_V2 = '{"openapi":"3.1.0","paths":{"/x":{}}}';

function writePackage(version: string): void {
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: PACKAGE_NAME, version }),
    'utf8',
  );
}

function publish(version: string, document: string): void {
  const path = publishedBaselinePath(packageDir, version);
  mkdirSync(join(packageDir, 'openapi', 'published'), { recursive: true });
  writeFileSync(path, document, 'utf8');
}

beforeEach(() => {
  packageDir = mkdtempSync(join(tmpdir(), 'version-check-'));
});

afterEach(() => {
  rmSync(packageDir, { recursive: true, force: true });
});

describe('a contract that may ship', () => {
  it('accepts an unchanged contract at the published version', () => {
    writePackage('0.1.0');
    publish('0.1.0', DOCUMENT_V1);

    expect(assertVersionBumped(packageDir, DOCUMENT_V1)).toEqual([]);
  });

  it('accepts a changed contract whose version was bumped', () => {
    writePackage('0.2.0');
    publish('0.1.0', DOCUMENT_V1);

    // The 0.2.0 baseline does not exist yet: a pull request bumps before it
    // publishes, and refusing that would make the workflow impossible.
    expect(assertVersionBumped(packageDir, DOCUMENT_V2)).toEqual([]);
  });

  it('accepts anything before the first publish, having nothing to compare', () => {
    writePackage('0.1.0');

    expect(assertVersionBumped(packageDir, DOCUMENT_V2)).toEqual([]);
  });

  it('reads 1.10.0 as higher than 1.9.0, not lower', () => {
    writePackage('1.10.0');
    publish('1.9.0', DOCUMENT_V1);

    // A string comparison would put '1.10.0' below '1.9.0' and refuse a valid
    // bump, which is the failure this case exists to catch.
    expect(assertVersionBumped(packageDir, DOCUMENT_V2)).toEqual([]);
  });
});

describe('a contract that may not ship', () => {
  it('refuses a changed contract at an unchanged version', () => {
    writePackage('0.1.0');
    publish('0.1.0', DOCUMENT_V1);

    const findings = assertVersionBumped(packageDir, DOCUMENT_V2);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toBe('unbumped');
    expect(findings[0]?.publishedVersion).toBe('0.1.0');
    // The message has to say what to DO, because the person reading it in a
    // failed pipeline has no other context.
    expect(findings[0]?.message).toContain('contracts:publish');
  });

  it('refuses a version that moved backwards', () => {
    writePackage('0.1.0');
    publish('0.2.0', DOCUMENT_V1);

    const findings = assertVersionBumped(packageDir, DOCUMENT_V2);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toBe('not-higher');
  });

  it('refuses a version it cannot compare', () => {
    writePackage('0.2.0-rc.1');
    publish('0.1.0', DOCUMENT_V1);

    const findings = assertVersionBumped(packageDir, DOCUMENT_V2);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toBe('unreadable-version');
  });

  it('refuses a change of any size, not only a large one', () => {
    writePackage('0.1.0');
    // One byte apart. The gate asks "did anything change", never "how much" —
    // gate 3 owns the question of whether a change is breaking.
    publish('0.1.0', `${DOCUMENT_V1} `);

    expect(assertVersionBumped(packageDir, DOCUMENT_V1)).toHaveLength(1);
  });
});
