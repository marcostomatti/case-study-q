/**
 * Gate 4 over this package: spec section 2.1 forbids a contract package from
 * depending on `@marcos-corp/db`.
 *
 * The rule is what keeps this package a *contract* rather than the database
 * schema with a URL in front of it. `packages/db` spells the card's state
 * column `lifecycle_status` and gives it five members; `CardState` here
 * publishes four plus `unknown`. The remaining-spend figure the mobile view
 * renders has no column at all. Neither divergence survives a package that can
 * reach the schema, because the cheapest way to publish a shape is always to
 * re-export the one already written down.
 *
 * `assertNoDbImport` from `@marcos-corp/contract-tooling` is the gate CI runs.
 * Its own suite proves the gate sees every shape of dependency; this file makes
 * the claim that suite cannot, which is that *this* package has none of them.
 *
 * ## Why an empty finding list needs controls beside it
 *
 * `[]` is what a clean package and an unread directory both look like. A walk
 * that resolved somewhere else, a manifest reading that looked at the wrong
 * object, a scan that never descended past the package root — every one of
 * those returns exactly the answer a clean package produces. So the clean case
 * is only worth reading beside legs that invert it: a **copy** of this package,
 * mutated to declare the dependency in each manifest field and to import it
 * from two of this package's real modules, each of which must be reported.
 * Skill: `accepting-cases-need-inverted-legs`.
 *
 * The copy is byte-identical to this package apart from the plant, so a leg
 * that fires says the gate read *these* files rather than a scratch tree that
 * happens to have the same shape. One further case asserts the unmutated copy
 * is as clean as the original, which is what ties the two together.
 *
 * ## Why the manifest is read twice
 *
 * The second block re-reads `package.json` directly rather than going through
 * the gate. That is deliberate duplication: a gate whose manifest half broke
 * would report `[]` here and the direct reading would still hold the line. Two
 * spellings of one claim are only worth having when they are independent, so
 * this one names the dependency fields itself instead of importing the gate's
 * list. Skill: `convert-exactly-one-spelling`.
 *
 * Note this file is itself scanned by the clean case below — every source file
 * in the package is, test files included. The planted import strings are built
 * by interpolating `DB_PACKAGE_NAME` and so never appear as a specifier, and a
 * specifier inside a string literal is not an import in any case. Tolerating
 * that is the gate's own suite's claim; here it is simply relied on.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertNoDbImport, DB_PACKAGE_NAME } from '@marcos-corp/contract-tooling';
import { afterAll, describe, expect, it } from 'vitest';

/** Two-space JSON, matching what this repo commits. Only used for mutated copies. */
const JSON_INDENT = 2;

/** This file sits in `src/`, so the package root is one level up. */
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MANIFEST_PATH = join(PACKAGE_DIR, 'package.json');

/** What the manifest at `MANIFEST_PATH` must name, as a check on the path itself. */
const PACKAGE_NAME = '@marcos-corp/contracts-service-a';

/**
 * Manifest fields whose value maps a package name to a version range, and the
 * two spellings npm accepts for the list form.
 *
 * Named here rather than imported from `@marcos-corp/contract-tooling` on
 * purpose — this block exists to be a second, independent reading of the
 * manifest, and sharing the gate's list would make it agree with the gate
 * about which fields are worth looking at. The claim that the gate covers the
 * whole matrix belongs to that package's own suite.
 */
const VERSIONED_DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

const BUNDLED_DEPENDENCY_FIELDS = ['bundleDependencies', 'bundledDependencies'] as const;

/**
 * Modules the source-import legs plant into. One at the package root and one a
 * directory down, so a walk that never descended is a red case rather than an
 * assumption.
 */
const PLANT_TARGETS = ['src/index.ts', 'src/schemas/card.ts'];

/** Only the manifest keys these cases read or write. */
interface MutableManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bundleDependencies?: string[];
  bundledDependencies?: string[];
}

const readManifest = (path: string): MutableManifest => JSON.parse(
  readFileSync(path, 'utf8'),
) as MutableManifest;

/** Scratch roots to remove once the file is done, one per leg that copies. */
const scratchRoots: string[] = [];

/**
 * A copy of this package under `tmpdir()`, minus `node_modules` — bun's
 * isolated linker symlinks this leaf's dependencies there, and the gate skips
 * that directory for the same reason.
 */
function packageCopy(): string {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'contracts-service-a-db-gate-'));
  scratchRoots.push(scratchRoot);

  const destination = join(scratchRoot, basename(PACKAGE_DIR));
  cpSync(PACKAGE_DIR, destination, {
    recursive: true,
    filter: (source) => basename(source) !== 'node_modules',
  });
  return destination;
}

afterAll(() => {
  scratchRoots.forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('the dependency gate over this package', () => {
  it('is pointed at this package, not at a directory resolved somewhere else', () => {
    // `assertNoDbImport` throws on a directory with no manifest, so a typo'd
    // path cannot read as clean — but a sibling package has a manifest too,
    // and a clean report about the wrong one proves nothing about this one.
    expect(readManifest(MANIFEST_PATH).name).toBe(PACKAGE_NAME);
  });

  it('reports no finding at all', () => {
    // The claim proper: no manifest field declares the database package and no
    // source file in this package imports it, subpaths and type-only imports
    // included.
    expect(assertNoDbImport(PACKAGE_DIR)).toEqual([]);
  });

  it('reports nothing for the unmutated copy the controls below start from', () => {
    // What lets the legs below say anything about this package rather than
    // about a scratch tree: the copy answers the same way the original does,
    // so the only difference a firing leg can be reading is its own plant.
    expect(assertNoDbImport(packageCopy())).toEqual([]);
  });

  it.each(VERSIONED_DEPENDENCY_FIELDS)(
    'reports the database package declared in %s',
    (field) => {
      const copy = packageCopy();
      const manifestPath = join(copy, 'package.json');
      const manifest = readManifest(manifestPath);
      manifest[field] = { ...manifest[field], [DB_PACKAGE_NAME]: '0.1.0' };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, JSON_INDENT)}\n`);

      // The load-bearing guard. A plant that silently missed leaves a clean
      // package, and a clean report is indistinguishable from the mutation
      // never having applied.
      expect(readManifest(manifestPath)[field]).toHaveProperty(DB_PACKAGE_NAME);

      const findings = assertNoDbImport(copy);

      expect(findings).toEqual([
        expect.objectContaining({
          field,
          file: 'package.json',
          kind: 'manifest-dependency',
          specifier: DB_PACKAGE_NAME,
        }),
      ]);
      expect(findings[0]?.message).toContain(DB_PACKAGE_NAME);
    },
  );

  it.each(PLANT_TARGETS)('reports a type-only import planted in %s', (relativePath) => {
    const copy = packageCopy();
    const target = join(copy, relativePath);

    // Type-only on purpose: it emits no JavaScript and costs nothing to
    // install, so it is the shape most likely to be argued as harmless — and
    // it is exactly the one spec section 2.1 forbids, because the published
    // contract type then *is* the row type.
    const planted = `import type { Card } from '${DB_PACKAGE_NAME}';`;
    const before = readFileSync(target, 'utf8');
    const after = `${before}\n${planted}\n`;
    writeFileSync(target, after);

    // The load-bearing guard, and it re-reads rather than trusting `after`: a
    // write that never landed leaves a clean copy, and a clean report is
    // indistinguishable from the plant never having applied.
    expect(readFileSync(target, 'utf8')).toContain(planted);

    const findings = assertNoDbImport(copy);

    expect(findings).toEqual([
      expect.objectContaining({
        file: relativePath,
        kind: 'source-import',
        line: after.split('\n').indexOf(planted) + 1,
        specifier: DB_PACKAGE_NAME,
      }),
    ]);
    expect(findings[0]?.message).toContain(relativePath);
  });
});

describe('the package manifest', () => {
  it('declares the database package in no dependency field', () => {
    const manifest = readManifest(MANIFEST_PATH);

    VERSIONED_DEPENDENCY_FIELDS.forEach((field) => {
      expect(Object.keys(manifest[field] ?? {})).not.toContain(DB_PACKAGE_NAME);
    });
    BUNDLED_DEPENDENCY_FIELDS.forEach((field) => {
      expect(manifest[field] ?? []).not.toContain(DB_PACKAGE_NAME);
    });

    // The positive control, in the same case and varied along the same axis.
    // A reading that resolved to an empty object — a renamed field, a manifest
    // that failed to parse into the shape above — satisfies every assertion
    // so far, so the same reading has to find the dependencies that are there.
    expect(Object.keys(manifest.dependencies ?? {})).toContain('@sinclair/typebox');
    // And the near miss: `@marcos-corp/contract-tooling` is a legitimate
    // `@marcos-corp` dependency of this package, so a check written as "no
    // first-party dependency at all" fails here rather than passing forever.
    expect(Object.keys(manifest.devDependencies ?? {})).toContain('@marcos-corp/contract-tooling');
  });
});
