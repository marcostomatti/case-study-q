/**
 * Gate 4 of the four blocking gates in spec section 8: no contract package may
 * depend on `@marcos-corp/db` (spec section 2.1).
 *
 * The rule exists because a contract derived from the database schema is not a
 * contract — it is the schema with a URL in front of it. Every column rename
 * then reaches consumers as a breaking change, and the shape the provider is
 * free to refactor and the shape it has promised stop being separable. So the
 * database package is not a dependency of a contract package, is not imported
 * by one, and this gate is what keeps that true after the day it was decided.
 *
 * Unlike the lint and diff gates there is no external binary here, which makes
 * the failure modes different but no less silent:
 *
 *   1. **A missed import reads exactly like a clean package.** A check built
 *      on a line-wise search misses an import wrapped across lines — the most
 *      ordinary formatting there is — and a `require()` or an `import()` call
 *      is not spelled like a static import at all. Every one of those is a
 *      real way to take the schema, so the scan below is the TypeScript
 *      preprocessor rather than a pattern over the text.
 *   2. **A directory that was never read also reads like a clean package.**
 *      Nothing distinguishes "scanned and found nothing" from "walked the
 *      wrong tree", so a package with no manifest, or a `contractPackageDir`
 *      that is not a directory at all, throws rather than returning an empty
 *      list.
 *
 * That second point is the same split `lintSpec`, `diffSpecs` and
 * `tools/control-byte-gate` make: the package under test being bad is a
 * returned finding, the gate being unable to run is a throw. A gate that could
 * not run must never be mistaken for a gate that passed.
 *
 * Type-only imports are findings too. `import type { Card } from
 * '@marcos-corp/db'` emits no JavaScript, so it is invisible at runtime and
 * costs nothing to install — and it is precisely the shape spec section 2.1
 * forbids, because the published contract type then *is* the row type. The
 * gate is about where the shape came from, not about what survives to the
 * bundle.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

/**
 * The database package contract packages must keep clear of. Exported so
 * `gates.ts`, `scripts/pipeline-simulation.ts` and acceptance script 03 name
 * it from one place rather than each spelling it out.
 */
export const DB_PACKAGE_NAME = '@marcos-corp/db';

/**
 * Manifest fields whose value is a map of package name to version range.
 * Reported in this order, so a package declaring the database in two of them
 * produces a stable list.
 *
 * `devDependencies` counts. A contract package's tests are published with it
 * in this repo — the package *is* its source tree — and a dev-only dependency
 * on the schema still means the contract was written while looking at it.
 */
const VERSIONED_DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** Manifest fields whose value is a list of package names. npm accepts both spellings. */
const BUNDLED_DEPENDENCY_FIELDS = ['bundleDependencies', 'bundledDependencies'] as const;

/**
 * Extensions the TypeScript preprocessor understands. `.json` is deliberately
 * absent: the committed `openapi/*.json` artifacts mention package names in
 * prose and are not code.
 */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Directories that hold something other than the package's own source.
 * `node_modules` matters most: bun's isolated linker symlinks a leaf's
 * dependencies there, so reading it would report every legitimate consumer of
 * the schema as a violation inside the contract package that merely sits next
 * to it.
 */
const UNSCANNED_DIRECTORIES = new Set([
  '.git',
  '.tmp',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

/** Named once so both finding kinds explain the rule the same way. */
const RULE = `spec section 2.1: a contract package must not depend on '${DB_PACKAGE_NAME}', or `
  + 'every database column rename reaches consumers as a breaking change';

/** A dependency declared in the package manifest. */
export interface ManifestDependencyFinding {
  kind: 'manifest-dependency';
  /** Always `package.json`; present so both finding kinds carry a file. */
  file: 'package.json';
  /** The manifest field that declares it, e.g. `devDependencies`. */
  field: string;
  /** The declared package name. Always exactly `DB_PACKAGE_NAME`. */
  specifier: string;
  message: string;
}

/** An import of the database package from a source file. */
export interface SourceImportFinding {
  kind: 'source-import';
  /** Package-relative, forward-slashed on every platform. */
  file: string;
  /** 1-based line the specifier sits on. */
  line: number;
  /** The specifier as written, so a subpath import names the subpath. */
  specifier: string;
  message: string;
}

export type DependencyFinding = ManifestDependencyFinding | SourceImportFinding;

/**
 * True for the package itself and for any subpath of it, and false for a
 * package that merely starts with the same characters — `@marcos-corp/db-fixtures`
 * is a different package, and a `startsWith` check on the bare name reports it.
 */
const isDatabaseSpecifier = (specifier: string): boolean => specifier === DB_PACKAGE_NAME
  || specifier.startsWith(`${DB_PACKAGE_NAME}/`);

/** 1-based line of a character offset. */
const lineAt = (source: string, offset: number): number => source.slice(0, offset).split('\n').length;

/** Package-relative and forward-slashed, so a report reads the same everywhere. */
const packageRelative = (packageDir: string, filePath: string): string => relative(packageDir, filePath)
  .split(sep)
  .join('/');

function readManifest(packageDir: string): Record<string, unknown> {
  const manifestPath = join(packageDir, 'package.json');

  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (cause) {
    throw new Error(
      `dependency gate cannot run: no package.json at '${manifestPath}', so there is no `
      + 'contract package there to clear',
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`dependency gate cannot run: '${manifestPath}' is not valid JSON`, { cause });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`dependency gate cannot run: '${manifestPath}' is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function manifestFindings(manifest: Record<string, unknown>): ManifestDependencyFinding[] {
  const declaredIn = (field: string): ManifestDependencyFinding => ({
    kind: 'manifest-dependency',
    file: 'package.json',
    field,
    specifier: DB_PACKAGE_NAME,
    message: `package.json declares '${DB_PACKAGE_NAME}' in ${field} — ${RULE}`,
  });

  const versioned = VERSIONED_DEPENDENCY_FIELDS.filter((field) => {
    const value = manifest[field];
    return typeof value === 'object'
      && value !== null
      && Object.hasOwn(value, DB_PACKAGE_NAME);
  });

  const bundled = BUNDLED_DEPENDENCY_FIELDS.filter((field) => {
    const value = manifest[field];
    return Array.isArray(value) && value.includes(DB_PACKAGE_NAME);
  });

  return [...versioned, ...bundled].map(declaredIn);
}

/**
 * Every source file under `packageDir`, sorted, with the directories that hold
 * something other than the package's own source left unread.
 *
 * Only real directories are descended into. A symlink reports as neither a
 * file nor a directory here, which keeps the walk out of the cycles bun's
 * isolated linker creates.
 */
function sourceFiles(packageDir: string): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    entries.forEach((entry) => {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!UNSCANNED_DIRECTORIES.has(entry.name)) walk(entryPath);
        return;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        found.push(entryPath);
      }
    });
  };

  walk(packageDir);
  return found;
}

/**
 * The imports one source file makes, read with TypeScript's own preprocessor.
 *
 * This is the reason the check is not a pattern over the text. `preProcessFile`
 * runs the real scanner, so it sees an import wrapped across lines, a
 * `require()`, a dynamic `import()`, a re-export and a type-only import — and
 * it does *not* see an import inside a comment or quoted in a string literal,
 * both of which contain every character a search would look for and neither of
 * which is a dependency.
 */
function importFindings(packageDir: string, filePath: string): SourceImportFinding[] {
  const source = readFileSync(filePath, 'utf8');
  const file = packageRelative(packageDir, filePath);

  // `detectJavaScriptImports` is what adds `require()` and `define()` to the
  // scan; without it a CommonJS require of the schema is invisible.
  return ts.preProcessFile(source, true, true).importedFiles
    .filter((imported) => isDatabaseSpecifier(imported.fileName))
    .map((imported) => {
      const line = lineAt(source, imported.pos);
      return {
        kind: 'source-import',
        file,
        line,
        specifier: imported.fileName,
        message: `${file}:${line} imports '${imported.fileName}' — ${RULE}`,
      };
    });
}

/**
 * Reports every way the contract package at `contractPackageDir` depends on
 * `@marcos-corp/db`: a declaration in any manifest dependency field, and an
 * import of the package or any of its subpaths from any source file it owns.
 *
 * An empty list is the passing result. Findings are ordered manifest first,
 * then by file and by line, so two runs over the same package produce the same
 * report.
 *
 * Throws when the check could not be made rather than reporting a clean
 * package: a `contractPackageDir` that is not a directory, or one holding no
 * readable `package.json`.
 */
export function assertNoDbImport(contractPackageDir: string): DependencyFinding[] {
  const packageDir = resolve(contractPackageDir);

  const packageStat = statSync(packageDir, { throwIfNoEntry: false });
  if (packageStat === undefined || !packageStat.isDirectory()) {
    throw new Error(
      `dependency gate cannot run: contract package directory not found at '${packageDir}'`,
    );
  }

  const manifest = readManifest(packageDir);

  return [
    ...manifestFindings(manifest),
    ...sourceFiles(packageDir).flatMap((filePath) => importFindings(packageDir, filePath)),
  ];
}
