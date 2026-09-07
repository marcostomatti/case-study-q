/**
 * Resolves the baseline gate 3 diffs against: the highest version a contract
 * package has published.
 *
 * There is no npm registry in this proof of concept. "Published" means the
 * emitted OpenAPI document is committed to
 * `packages/contracts-<svc>/openapi/published/<version>.json`, while
 * `openapi/openapi.json` holds the working emit a pull request proposes. That
 * directory is the artifact a registry would otherwise hold, which makes this
 * lookup the thing that decides what `diffSpecs` compares against.
 *
 * Two properties follow from that, and both point the same way:
 *
 *   1. Every way of getting this wrong is silent. Return the wrong file and
 *      oasdiff still runs, still exits 0, and still reports no breaking
 *      changes — against a baseline nobody published. Nothing downstream can
 *      tell that apart from a genuinely safe change.
 *   2. `null` is a real answer, not an error. Before its first publish a
 *      contract package has no baseline, and gate 3 has nothing to compare
 *      against rather than something to reject.
 *
 * So the split here is narrow on purpose: `null` means "this package has
 * published nothing yet", and everything else that could produce a wrong
 * answer throws. A document whose filename is not a version throws rather
 * than being skipped, because skipping it silently resolves to the
 * second-highest version — the one case where a quiet fallback publishes a
 * breaking change. That mirrors `lintSpec`, `diffSpecs` and
 * `tools/control-byte-gate`: the thing under test being bad is a returned
 * result, the gate being unable to answer is a throw.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Baselines live at `<contract package>/openapi/published/`, one document per
 * published version. Split into segments so the path is built the same way on
 * every platform.
 */
const PUBLISHED_SEGMENTS = ['openapi', 'published'] as const;

/**
 * `<major>.<minor>.<patch>.json`, with semver's own rule against leading
 * zeroes. Deliberately narrower than full semver: a prerelease or build
 * suffix has no ordering this repo has agreed on, and guessing one is how a
 * baseline gets picked wrongly. Contract packages publish release versions,
 * so anything else is a mistake worth reporting.
 */
const PUBLISHED_DOCUMENT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.json$/;

interface PublishedVersion {
  major: number;
  minor: number;
  patch: number;
}

interface PublishedDocument {
  fileName: string;
  version: PublishedVersion;
}

/** Positive when `a` is the later version. Field order is semver's. */
const compareVersions = (a: PublishedVersion, b: PublishedVersion): number => a.major - b.major
  || a.minor - b.minor
  || a.patch - b.patch;

function parseVersion(fileName: string): PublishedVersion | null {
  const match = PUBLISHED_DOCUMENT.exec(fileName);
  if (match === null) return null;

  const [, major, minor, patch] = match;
  // Unreachable — the pattern has three groups — but the compiler cannot know
  // that, and a cast here would be a cast in the one place being careful is
  // the entire point.
  if (major === undefined || minor === undefined || patch === undefined) return null;

  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

/**
 * Returns the path of the highest version published by the contract package
 * at `contractPackageDir`, or `null` when it has published none.
 *
 * The returned path is absolute regardless of what was passed in, so a caller
 * can hand it to `diffSpecs` without knowing which directory it was resolved
 * from.
 *
 * Files under `openapi/published/` that are not `.json` are ignored — a
 * README belongs there and is not a baseline. A `.json` file that is not
 * named `<major>.<minor>.<patch>.json` throws, as does a
 * `contractPackageDir` that is not a directory.
 */
export function latestPublishedSpec(contractPackageDir: string): string | null {
  const packageDir = resolve(contractPackageDir);

  const packageStat = statSync(packageDir, { throwIfNoEntry: false });
  if (packageStat === undefined || !packageStat.isDirectory()) {
    throw new Error(
      'published-baseline lookup cannot run: contract package directory not found at '
      + `'${packageDir}'`,
    );
  }

  const publishedDir = join(packageDir, ...PUBLISHED_SEGMENTS);
  const publishedStat = statSync(publishedDir, { throwIfNoEntry: false });
  // Absent is the pre-first-publish state, and is the same answer as present
  // and empty: nothing has been published, so there is no baseline to diff
  // against.
  if (publishedStat === undefined || !publishedStat.isDirectory()) return null;

  const published: PublishedDocument[] = readdirSync(publishedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const version = parseVersion(entry.name);
      if (version === null) {
        throw new Error(
          `published-baseline lookup cannot run: '${join(publishedDir, entry.name)}' is not named `
          + '<major>.<minor>.<patch>.json, so which published version is highest '
          + 'cannot be decided',
        );
      }
      return { fileName: entry.name, version };
    });

  // Sorting a freshly built array, so nothing shared is being reordered.
  const [highest] = published.sort((a, b) => compareVersions(b.version, a.version));
  if (highest === undefined) return null;

  return join(publishedDir, highest.fileName);
}
