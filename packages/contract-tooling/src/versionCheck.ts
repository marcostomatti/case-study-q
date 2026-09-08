/**
 * The gate that makes an exact pin mean something.
 *
 * Spec §2.2 has consumers pin a contract package to an exact version so that
 * adopting a new contract is a reviewed pull request. That mechanism rests on
 * an assumption nothing else in the pipeline checks: **the content published
 * under a version never changes.** Without this gate it does. Measured, before
 * this file existed: a field was added to `contracts-service-a`, the artifact
 * was re-emitted and committed, the version was left at `0.1.0`, and all four
 * spec §8 gates passed. A consumer pinned at `"0.1.0"` would then have received
 * a contract it never reviewed, which is the whole of tier 2 defeated in one
 * merge.
 *
 * The rule is one sentence: **if the emitted document differs from the latest
 * published baseline, the package version must be higher than that baseline's.**
 *
 * The workflow it produces:
 *
 * 1. Change the contract, bump the version, re-emit, commit. Gate 3 diffs the
 *    emit against the still-current baseline and catches any break; this gate
 *    sees the difference and is satisfied by the bump.
 * 2. Merge.
 * 3. At release, `contracts:publish` writes `openapi/published/<version>.json`.
 *    Emit and latest baseline now agree, and this gate has nothing to say until
 *    the contract next changes.
 *
 * Publishing is a committed file rather than a CI push on merge, deliberately.
 * A workflow that writes to `main` needs `contents: write` on a public
 * repository and fights branch protection; a committed baseline is reviewable
 * in the diff that changes it, which is the same argument as for the pin.
 */

import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { latestPublishedSpec } from './publishedBaseline';

/** Where a published baseline lives, relative to the contract package. */
const PUBLISHED_SEGMENTS = ['openapi', 'published'] as const;

/** `1.10.0` sorts above `1.9.0`, so versions compare numerically per segment. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type VersionViolationReason =
  /** The document changed and the version did not move. */
  | 'unbumped'
  /** The document changed and the version moved backwards or sideways. */
  | 'not-higher'
  /** The manifest version is not a three-segment release version. */
  | 'unreadable-version';

export interface VersionFinding {
  /** Always `package.json`, so a report reads like the pin gate's. */
  file: 'package.json';
  /** The contract package, by npm name. */
  packageName: string;
  /** The version the manifest declares. */
  version: string;
  /** The highest version with a committed baseline, or null before the first. */
  publishedVersion: string | null;
  reason: VersionViolationReason;
  message: string;
}

interface Semver { major: number; minor: number; patch: number }

function parseSemver(value: string): Semver | null {
  const match = SEMVER.exec(value);
  if (!match) return null;
  const [, major, minor, patch] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

/** Negative when `a` is lower, positive when higher, zero when equal. */
function compare(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Answers whether the contract may ship under the version its manifest
 * declares, given the document it emits.
 *
 * `emittedDocument` is the serialized emit, not a path: the caller has already
 * produced it for gates 2 and 3, and re-reading the committed artifact here
 * would check a different thing — a stale committed file would then satisfy
 * this gate while the contract it claims to describe had moved.
 *
 * Returns `[]` when the contract may ship, matching the shape of the other
 * gates. A version bumped past the baseline is accepted whether or not its own
 * baseline exists yet, because a pull request bumps before it publishes.
 */
export function assertVersionBumped(
  contractPackageDir: string,
  emittedDocument: string,
): VersionFinding[] {
  const packageDir = resolve(contractPackageDir);
  const manifest = JSON.parse(
    readFileSync(join(packageDir, 'package.json'), 'utf8'),
  ) as { name: string; version: string };

  const baselinePath = latestPublishedSpec(packageDir);

  // Nothing published yet. There is no version this contract could be
  // colliding with, so there is nothing to enforce — the same answer gate 3
  // gives, and for the same reason.
  if (baselinePath === null) return [];

  const publishedVersion = basename(baselinePath, '.json');

  // Byte comparison rather than a semantic diff: gate 3 already owns "is this
  // change breaking". This gate only asks "did anything change at all", and
  // any difference at all is enough to require a new version.
  if (readFileSync(baselinePath, 'utf8') === emittedDocument) return [];

  const declared = parseSemver(manifest.version);
  const published = parseSemver(publishedVersion);

  if (declared === null) {
    return [{
      file: 'package.json',
      packageName: manifest.name,
      version: manifest.version,
      publishedVersion,
      reason: 'unreadable-version',
      message:
        `${manifest.name} declares version '${manifest.version}', which is not a `
        + '<major>.<minor>.<patch> release version, so whether it is higher than the '
        + `published '${publishedVersion}' cannot be decided`,
    }];
  }

  // `published` came from a filename `latestPublishedSpec` already validated
  // against the same shape, so this cannot be null in practice.
  if (published !== null && compare(declared, published) > 0) return [];

  const reason: VersionViolationReason = manifest.version === publishedVersion
    ? 'unbumped'
    : 'not-higher';

  return [{
    file: 'package.json',
    packageName: manifest.name,
    version: manifest.version,
    publishedVersion,
    reason,
    message:
      `${manifest.name}'s contract differs from the published baseline `
      + `${publishedVersion} but its version is '${manifest.version}', which is not higher. `
      + 'Spec section 2.2 has consumers pin an exact version, so the content published under '
      + 'a version must never change — a consumer pinned at that version would receive a '
      + 'contract it never reviewed. Bump the version, re-run contracts:emit, and publish '
      + 'the new baseline with contracts:publish.',
  }];
}

/** Where `contracts:publish` writes the baseline for a given version. */
export function publishedBaselinePath(contractPackageDir: string, version: string): string {
  return join(resolve(contractPackageDir), ...PUBLISHED_SEGMENTS, `${version}.json`);
}
