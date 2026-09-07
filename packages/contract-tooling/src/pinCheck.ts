/**
 * The pin gate: a consumer depends on a contract package at an exact version,
 * never a range (spec section 2.2).
 *
 * It sits beside the four blocking gates of spec section 8 rather than inside
 * them, because it reads a *consumer's* manifest while those four read a
 * contract package. CI runs it as its own job across every consuming package,
 * so a caret on a contract dependency fails the pull request that introduced
 * it.
 *
 * The friction is the whole point. `^1.4.0` means an install can move a
 * consumer onto a contract version nobody reviewed, and the manifest then
 * records a range instead of a fact. `1.4.0` means adopting a new contract
 * version is a diff — one line, in a path CODEOWNERS routes to a reviewer —
 * and that diff is the only record this repository has of which consumer runs
 * against which contract. Everything downstream that answers "who is affected"
 * reads it.
 *
 * So the check is **default-deny**: exactly a semver version passes, and every
 * other specifier a package manager would accept is a finding. That is
 * deliberate rather than lazy. A gate written the obvious way — reject a
 * leading `^` or `~` — passes `*`, `0.1.x`, `latest`, `>=0.1.0` and
 * `workspace:*`, all of which float the consumer exactly as far, and passes
 * whatever specifier syntax a future package manager introduces. An
 * unrecognised specifier is the one case where failing closed costs a
 * conversation and failing open costs the property the gate exists to hold.
 *
 * `workspace:*` deserves its own mention because it is the tempting one in a
 * monorepo: it resolves, it type-checks, and it is what most workspace
 * tutorials write. It also links whatever version the workspace happens to
 * hold, so bumping a contract package reaches every consumer with no pull
 * request at all — the exact outcome spec section 2.2 exists to prevent.
 *
 * Same split as the other gates in this package, and as
 * `tools/control-byte-gate`: the manifest under test being bad is a returned
 * finding, the gate being unable to read it is a throw. A gate that could not
 * run must never be mistaken for a gate that passed.
 */
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The prefix every governed package shares. Exported so the CI pins job,
 * `scripts/pipeline-simulation.ts` and acceptance script 05 name it from one
 * place rather than each spelling it out.
 *
 * The trailing `s-` is load-bearing: `@marcos-corp/contract-tooling` is not a
 * contract package and is ranged like any other library.
 */
export const CONTRACT_PACKAGE_PREFIX = '@marcos-corp/contracts-';

/**
 * Manifest fields whose value is a map of package name to version specifier.
 * Reported in this order, so a package pinning the same contract in two of
 * them produces a stable list.
 *
 * All four count. A contract taken as a peer or optional dependency is still a
 * contract this consumer is built against, and a ranged specifier loses the
 * record just as completely there.
 */
const VERSIONED_DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** The workspace protocol, which resolves against the tree rather than a version. */
const WORKSPACE_PROTOCOL = 'workspace:';

/**
 * A complete semver version and nothing else: three numeric segments with
 * semver's own rule against leading zeroes, plus its optional prerelease and
 * build metadata. This is the only specifier the gate accepts.
 */
const EXACT_VERSION
  = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** A leading comparator: `^0.1.0`, `~0.1.0`, `>=0.1.0`, `=0.1.0`. */
const RANGE_OPERATOR = /^[\^~=<>]/;

/**
 * The ranges with no leading comparator — `0.1.0 || 0.2.0` and
 * `0.1.0 - 0.2.0` — plus any space-joined pair of comparators. Tested against
 * a trimmed specifier, so the whitespace it finds is always internal.
 */
const COMPOUND_RANGE = /\|\||\s/;

/** Segments a package manager reads as "any value here". */
const WILDCARD_SEGMENTS = new Set(['*', 'x', 'X']);

const NUMERIC_SEGMENT = /^\d+$/;

/** Named once so every finding explains the rule the same way. */
const RULE = 'spec section 2.2: a consumer pins a contract package to an exact version, never a '
  + 'range, so that adopting a new contract version is a reviewed pull request';

/** Why a specifier is not an exact pin. */
export type PinViolationReason =
  | 'range'
  | 'wildcard'
  | 'workspace-protocol'
  | 'not-a-version';

/**
 * Half of each finding's message. Written to read as the middle of the
 * sentence the message builds, and to say what the specifier lets happen
 * rather than only what it is.
 */
const REASON_EXPLANATION: Record<PinViolationReason, string> = {
  range: 'is a version range, so an install can move this consumer onto a contract version '
    + 'nobody reviewed',
  wildcard: 'accepts every published version, so the manifest records no contract version at all',
  'workspace-protocol': 'resolves against the workspace rather than a recorded version, so a '
    + 'contract bump reaches this consumer with no pull request',
  'not-a-version': 'is not a version, so the manifest does not record which contract this '
    + 'consumer was built against',
};

/** A contract dependency declared with something other than an exact version. */
export interface PinFinding {
  /** Always `package.json`; present so a report reads the same as gate 4's. */
  file: 'package.json';
  /** The manifest field that declares it, e.g. `devDependencies`. */
  field: string;
  /** The governed package, always prefixed `CONTRACT_PACKAGE_PREFIX`. */
  packageName: string;
  /** The specifier exactly as written, so the message names what to replace. */
  specifier: string;
  reason: PinViolationReason;
  message: string;
}

/**
 * True for `*`, `x`, `1`, `0.1`, `0.1.x` and `0.1.*`: a version with a segment
 * missing or replaced by a wildcard, which a package manager reads as every
 * version sharing the prefix.
 *
 * Only reached after `EXACT_VERSION` has been tried, so a complete version
 * never lands here. A malformed one — `01.4.0`, say — is not a wildcard and
 * falls through to `not-a-version`, which is the honest answer for it.
 */
function isWildcardRange(value: string): boolean {
  // A package manager reads an empty specifier exactly as `*`.
  if (value === '') return true;

  const segments = value.split('.');
  if (segments.length > 3) return false;

  const readable = segments
    .every((segment) => WILDCARD_SEGMENTS.has(segment) || NUMERIC_SEGMENT.test(segment));
  if (!readable) return false;

  return segments.length < 3 || segments.some((segment) => WILDCARD_SEGMENTS.has(segment));
}

/** `null` for an exact version; otherwise why the specifier is not one. */
function classify(specifier: string): PinViolationReason | null {
  const value = specifier.trim();

  // Checked before the exact test on purpose: `workspace:0.1.0` names a
  // version and still links whatever the workspace holds.
  if (value.startsWith(WORKSPACE_PROTOCOL)) return 'workspace-protocol';
  if (EXACT_VERSION.test(value)) return null;
  if (isWildcardRange(value)) return 'wildcard';
  if (RANGE_OPERATOR.test(value) || COMPOUND_RANGE.test(value)) return 'range';

  return 'not-a-version';
}

const pinFinding = (
  field: string,
  packageName: string,
  specifier: string,
  reason: PinViolationReason,
): PinFinding => ({
  file: 'package.json',
  field,
  packageName,
  specifier,
  reason,
  message: `package.json ${field} declares '${packageName}': '${specifier}', which `
    + `${REASON_EXPLANATION[reason]} — ${RULE}`,
});

function readManifest(packageDir: string): Record<string, unknown> {
  const manifestPath = join(packageDir, 'package.json');

  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (cause) {
    throw new Error(
      `pin gate cannot run: no package.json at '${manifestPath}', so there are no contract `
      + 'pins to read',
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`pin gate cannot run: '${manifestPath}' is not valid JSON`, { cause });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`pin gate cannot run: '${manifestPath}' is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * The contract pins one dependency field declares, sorted by package name so
 * two consumers listing the same pins in a different order produce the same
 * report.
 *
 * A field that is present but is not a map of package name to version string
 * throws. Skipping it would report a consumer as correctly pinned on the
 * strength of a field the gate could not read.
 */
function contractPins(
  manifest: Record<string, unknown>,
  field: string,
): Array<readonly [string, string]> {
  const declared = manifest[field];
  if (declared === undefined) return [];

  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
    throw new Error(
      `pin gate cannot run: '${field}' in package.json is not a map of package name to `
      + 'version, so the contract pins it holds cannot be read',
    );
  }

  return Object.entries(declared)
    .filter(([packageName]) => packageName.startsWith(CONTRACT_PACKAGE_PREFIX))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([packageName, specifier]) => {
      if (typeof specifier !== 'string') {
        throw new Error(
          `pin gate cannot run: ${field} pins '${packageName}' to something that is not a `
          + 'string, so the version it names cannot be read',
        );
      }
      return [packageName, specifier] as const;
    });
}

/**
 * Reports every dependency on a `@marcos-corp/contracts-*` package that the
 * consumer at `packageDir` declares with something other than an exact
 * version.
 *
 * An empty list is the passing result — including for a consumer that depends
 * on no contract package at all, which is why every caller asserting emptiness
 * needs a planted range to prove the manifest was read.
 *
 * Findings are ordered by dependency field and then by package name, so two
 * runs over the same manifest produce the same report.
 *
 * Throws when the check could not be made rather than reporting a clean
 * consumer: a `packageDir` that is not a directory, one holding no readable
 * `package.json`, or a dependency field that is not a map of package name to
 * version string.
 */
export function assertExactContractPins(packageDir: string): PinFinding[] {
  const consumerDir = resolve(packageDir);

  const consumerStat = statSync(consumerDir, { throwIfNoEntry: false });
  if (consumerStat === undefined || !consumerStat.isDirectory()) {
    throw new Error(`pin gate cannot run: package directory not found at '${consumerDir}'`);
  }

  const manifest = readManifest(consumerDir);

  return VERSIONED_DEPENDENCY_FIELDS.flatMap((field) => contractPins(manifest, field)
    .flatMap(([packageName, specifier]) => {
      const reason = classify(specifier);
      if (reason === null) return [];
      return [pinFinding(field, packageName, specifier, reason)];
    }));
}
