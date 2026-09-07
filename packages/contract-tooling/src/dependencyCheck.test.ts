import type { DependencyFinding } from './dependencyCheck';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertNoDbImport, DB_PACKAGE_NAME } from './dependencyCheck';

/**
 * Gate 4 of spec section 8, and the one gate here with no external binary
 * behind it: a contract package must not depend on `@marcos-corp/db`, because
 * a contract derived from the database schema republishes every column rename
 * as a breaking change.
 *
 * Two failure modes shape the cases below, and both are silent:
 *
 *   1. **A missed import.** A gate that reads only single-line `import ... from
 *      '@marcos-corp/db'` passes a package whose import is wrapped across
 *      lines, written as `import()`, or spelled with a subpath. Each of those
 *      is a real way to depend on the schema, so each gets its own case.
 *   2. **A gate that read nothing.** A clean package and an unscanned
 *      directory both return no findings. Every case asserting emptiness
 *      therefore plants a violation into the same package afterwards and
 *      asserts it is now found.
 *
 * The tolerance cases matter as much as the violation ones. A commented-out
 * import and an import quoted inside a string literal both contain every
 * character a grep would look for, and neither is a dependency.
 */

let scratchRoot = '';

beforeAll(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'contract-tooling-dependency-'));
});

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

interface PackageSpec {
  /** Merged over the baseline manifest, so a case names only what it changes. */
  manifest?: Record<string, unknown>;
  /** Package-relative path to file contents. Directories are created. */
  files?: Record<string, string>;
}

/**
 * Source a contract package could legitimately hold: TypeBox schemas behind a
 * ts-rest contract, and nothing from `@marcos-corp/db`. Present in every
 * scratch package so a "no findings" result is a statement about a package
 * with source in it, rather than about an empty directory.
 */
const CLEAN_CONTRACT = `
import { Type } from '@sinclair/typebox';
import { initContract } from '@ts-rest/core';

const c = initContract();

export const Card = Type.Object({
  lastFour: Type.String(),
}, { additionalProperties: false });

export const contract = c.router({
  readCard: {
    method: 'GET',
    path: '/cards/:cardId',
    responses: { 200: Card },
  },
});
`;

const writeInto = (packageDir: string, files: Record<string, string>): void => {
  Object.entries(files).forEach(([relativePath, contents]) => {
    const target = join(packageDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  });
};

const contractPackage = (spec: PackageSpec = {}): string => {
  const packageDir = mkdtempSync(join(scratchRoot, 'contracts-'));
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({
    name: '@marcos-corp/contracts-scratch',
    version: '0.1.0',
    private: true,
    dependencies: { '@sinclair/typebox': '^0.34.0', '@ts-rest/core': '^3.52.1' },
    ...spec.manifest,
  }, null, 2)}\n`);
  writeInto(packageDir, { 'src/contract.ts': CLEAN_CONTRACT, ...spec.files });
  return packageDir;
};

/**
 * `DependencyFinding` is a union, so reading `field` or `line` off a mixed
 * list needs narrowing. Both helpers below are paired with a length assertion
 * at the call site: filtering on its own would quietly drop a finding of the
 * wrong kind, which is one of the things these cases are meant to catch.
 */
const manifestFields = (findings: readonly DependencyFinding[]): string[] => findings
  .filter((finding) => finding.kind === 'manifest-dependency')
  .map((finding) => finding.field);

const sourceLines = (findings: readonly DependencyFinding[]): number[] => findings
  .filter((finding) => finding.kind === 'source-import')
  .map((finding) => finding.line);

/**
 * The positive control every emptiness assertion is paired with. Without it a
 * case passes just as convincingly against a check that reads the wrong
 * directory, or one that returns nothing unconditionally.
 */
const provePlantedImportIsFound = (packageDir: string): void => {
  writeInto(packageDir, {
    'src/__control.ts': `import { cards } from '${DB_PACKAGE_NAME}';\n\nexport { cards };\n`,
  });

  expect(assertNoDbImport(packageDir).map((finding) => finding.file)).toContain(
    'src/__control.ts',
  );
};

describe('a contract package that keeps clear of the database schema', () => {
  it('has no findings, and the same package reports a planted import', () => {
    const packageDir = contractPackage();

    expect(assertNoDbImport(packageDir)).toEqual([]);

    provePlantedImportIsFound(packageDir);
  });

  it('is not tripped by another workspace package with a similar name', () => {
    const packageDir = contractPackage({
      manifest: { dependencies: { '@marcos-corp/db-fixtures': '0.1.0' } },
      files: {
        'src/other.ts': `import { seed } from '${DB_PACKAGE_NAME}-fixtures';\n\nexport { seed };\n`,
      },
    });

    expect(assertNoDbImport(packageDir)).toEqual([]);

    provePlantedImportIsFound(packageDir);
  });
});

describe('a manifest that declares the database package', () => {
  it.each([
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ])('reports the %s field', (field) => {
    const packageDir = contractPackage({
      manifest: { [field]: { [DB_PACKAGE_NAME]: '0.1.0' } },
    });

    const findings = assertNoDbImport(packageDir);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'manifest-dependency',
      file: 'package.json',
      field,
      specifier: DB_PACKAGE_NAME,
    });
    // Spec section 9.3 asks the gate to name the offending declaration, so the
    // message has to carry both halves rather than only a rule name.
    expect(findings[0]?.message).toContain(DB_PACKAGE_NAME);
    expect(findings[0]?.message).toContain(field);
  });

  it('reports the bundledDependencies array, which is a list and not a map', () => {
    const packageDir = contractPackage({
      manifest: { bundledDependencies: ['@sinclair/typebox', DB_PACKAGE_NAME] },
    });

    expect(assertNoDbImport(packageDir)).toMatchObject([
      { kind: 'manifest-dependency', field: 'bundledDependencies' },
    ]);
  });

  it('reports every field that declares it, not only the first', () => {
    const packageDir = contractPackage({
      manifest: {
        dependencies: { [DB_PACKAGE_NAME]: '0.1.0' },
        devDependencies: { [DB_PACKAGE_NAME]: '0.1.0' },
      },
    });

    const findings = assertNoDbImport(packageDir);

    expect(findings).toHaveLength(2);
    expect(manifestFields(findings)).toEqual(['dependencies', 'devDependencies']);
  });
});

describe('a source file that imports the database package', () => {
  const importCases: ReadonlyArray<readonly [string, string]> = [
    ['a static named import', `import { cards } from '${DB_PACKAGE_NAME}';\n`],
    ['a dynamic import()', `const db = await import('${DB_PACKAGE_NAME}');\n`],
    ['a type-only import', `import type { Card } from '${DB_PACKAGE_NAME}';\n`],
    ['a side-effect import', `import '${DB_PACKAGE_NAME}';\n`],
    ['a re-export', `export * from '${DB_PACKAGE_NAME}';\n`],
    ['a require call', `const db = require('${DB_PACKAGE_NAME}');\n`],
    ['a default import', `import db from '${DB_PACKAGE_NAME}';\n`],
  ];

  it.each(importCases)('reports %s', (_label, statement) => {
    const packageDir = contractPackage({ files: { 'src/offending.ts': statement } });

    const findings = assertNoDbImport(packageDir);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'source-import',
      file: 'src/offending.ts',
      specifier: DB_PACKAGE_NAME,
      line: 1,
    });
    expect(findings[0]?.message).toContain(DB_PACKAGE_NAME);
  });

  it('reports an import wrapped across lines, which a line-wise scan misses', () => {
    const packageDir = contractPackage({
      files: {
        'src/offending.ts': `import {\n  cards,\n  companies,\n} from '${DB_PACKAGE_NAME}';\n`,
      },
    });

    // The whole point of the case: no single line of that file contains both
    // the keyword and the specifier.
    expect(assertNoDbImport(packageDir)).toMatchObject([
      { kind: 'source-import', file: 'src/offending.ts', line: 4 },
    ]);
  });

  it('reports a subpath import of the database package', () => {
    const packageDir = contractPackage({
      files: {
        'src/offending.ts': `import { cards } from '${DB_PACKAGE_NAME}/schema/cards';\n`,
      },
    });

    expect(assertNoDbImport(packageDir)).toMatchObject([
      { specifier: `${DB_PACKAGE_NAME}/schema/cards` },
    ]);
  });

  it('reports the line the import sits on, not the first line of the file', () => {
    const packageDir = contractPackage({
      files: {
        'src/offending.ts': `// a contract package\n\nimport { cards } from '${DB_PACKAGE_NAME}';\n`,
      },
    });

    expect(assertNoDbImport(packageDir)).toMatchObject([{ line: 3 }]);
  });

  it('reports every offending import in a file, not only the first', () => {
    const packageDir = contractPackage({
      files: {
        'src/offending.ts': `import { cards } from '${DB_PACKAGE_NAME}';\n`
          + `import { companies } from '${DB_PACKAGE_NAME}/schema';\n`,
      },
    });

    const findings = assertNoDbImport(packageDir);

    expect(findings).toHaveLength(2);
    expect(sourceLines(findings)).toEqual([1, 2]);
  });

  it('scans past src/, so an emit script cannot smuggle the schema in', () => {
    const packageDir = contractPackage({
      files: { 'scripts/emit.ts': `import { cards } from '${DB_PACKAGE_NAME}';\n` },
    });

    expect(assertNoDbImport(packageDir)).toMatchObject([{ file: 'scripts/emit.ts' }]);
  });

  it.each(['src/nested/deep/offending.ts', 'src/offending.mts', 'src/offending.js'])(
    'scans %s',
    (relativePath) => {
      const packageDir = contractPackage({
        files: { [relativePath]: `import { cards } from '${DB_PACKAGE_NAME}';\n` },
      });

      expect(assertNoDbImport(packageDir)).toMatchObject([{ file: relativePath }]);
    },
  );

  it('reports package-relative paths with forward slashes on every platform', () => {
    const packageDir = contractPackage({
      files: { 'src/nested/offending.ts': `import '${DB_PACKAGE_NAME}';\n` },
    });

    // `gates.ts` and acceptance script 03 print these; an absolute scratch path
    // or a backslash separator would leak the runner's filesystem into a report
    // a human is meant to read.
    expect(assertNoDbImport(packageDir)[0]?.file).toBe('src/nested/offending.ts');
  });
});

describe('text that looks like an import but is not one', () => {
  it('does not report a commented-out import', () => {
    const packageDir = contractPackage({
      files: {
        'src/notes.ts': `// import { cards } from '${DB_PACKAGE_NAME}';\n`
          + `/* import { companies } from '${DB_PACKAGE_NAME}'; */\n`
          + `/**\n * Deliberately never imports '${DB_PACKAGE_NAME}'.\n */\nexport {};\n`,
      },
    });

    expect(assertNoDbImport(packageDir)).toEqual([]);

    provePlantedImportIsFound(packageDir);
  });

  it('does not report an import quoted inside a string literal', () => {
    const packageDir = contractPackage({
      files: {
        'src/notes.ts': 'export const example ='
          + ` "import { cards } from '${DB_PACKAGE_NAME}';";\n`,
      },
    });

    expect(assertNoDbImport(packageDir)).toEqual([]);

    provePlantedImportIsFound(packageDir);
  });
});

describe('files the check must not read', () => {
  it('ignores an installed copy of the database package under node_modules', () => {
    const packageDir = contractPackage({
      files: {
        'node_modules/@marcos-corp/db/index.ts': `export * from '${DB_PACKAGE_NAME}/schema';\n`,
      },
    });

    // The isolated linker symlinks a leaf's own dependencies here. Reading it
    // would report every consumer of the schema as a violation of its own
    // contract package.
    expect(assertNoDbImport(packageDir)).toEqual([]);

    provePlantedImportIsFound(packageDir);
  });

  it('ignores build output and the committed OpenAPI artifacts', () => {
    const packageDir = contractPackage({
      files: {
        'dist/contract.js': `import { cards } from '${DB_PACKAGE_NAME}';\n`,
        'openapi/openapi.json': `{ "x-note": "import '${DB_PACKAGE_NAME}'" }\n`,
      },
    });

    expect(assertNoDbImport(packageDir)).toEqual([]);

    provePlantedImportIsFound(packageDir);
  });
});

describe('checks that must fail loudly rather than report a clean package', () => {
  /**
   * Each case asserts the `cannot run` wording as well as the offending path.
   * A bare filesystem error mentions the path too, so without it these pass
   * against a check that merely lets an ENOENT escape — which reaches a caller
   * as a crash rather than as the one thing it has to say, that the gate did
   * not run and the package is therefore unproven.
   */
  const cannotRun = /dependency gate cannot run/;

  it('throws when the contract package directory does not exist', () => {
    const missing = join(scratchRoot, 'contracts-nonexistent');

    expect(() => assertNoDbImport(missing)).toThrow(missing);
    expect(() => assertNoDbImport(missing)).toThrow(cannotRun);
  });

  it('throws when the package has no manifest', () => {
    const packageDir = mkdtempSync(join(scratchRoot, 'contracts-'));
    writeInto(packageDir, { 'src/contract.ts': CLEAN_CONTRACT });

    // Returning no findings here would read as "this contract package is
    // clean" for a directory that is not a package at all.
    expect(() => assertNoDbImport(packageDir)).toThrow(/package\.json/);
    expect(() => assertNoDbImport(packageDir)).toThrow(cannotRun);
  });

  it('throws when the manifest does not parse', () => {
    const packageDir = contractPackage();
    writeInto(packageDir, { 'package.json': '{ "name": "@marcos-corp/contracts-scratch",\n' });

    expect(() => assertNoDbImport(packageDir)).toThrow(/package\.json/);
    expect(() => assertNoDbImport(packageDir)).toThrow(cannotRun);
  });
});
