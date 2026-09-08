/**
 * Shared machinery for the spec §9 acceptance scripts.
 *
 * Every script here follows the same shape, and the shape is the point:
 *
 *   1. Assert the gates are GREEN on the untouched tree (the positive control).
 *   2. Mutate one file the way the criterion describes.
 *   3. Assert the gates go RED, and that the message names the actual cause.
 *   4. Restore the file, and assert green again.
 *
 * Step 1 is not ceremony. A script that only checks step 3 passes just as
 * happily against gates that reject everything — including gates broken so
 * badly they fail on an empty document. Without the control, "CI blocked it"
 * is unfalsifiable.
 *
 * Step 4 matters for a different reason: these scripts mutate tracked files in
 * the working tree. A crash between 2 and 4 would leave the repository dirty in
 * a way that looks like authored work, so restoration runs in a `finally` and
 * uses absolute paths — a relative path resolves against whatever directory the
 * process happens to be in by then.
 */

import fs from 'node:fs';
import path from 'node:path';

import { runGates, type GateName, type GateReport } from '@marcos-corp/contract-tooling';

import { contractPackages, REPO_ROOT, type ContractPackage } from '../contractPackages';

/** Exit code an acceptance script uses when its criterion is not demonstrated. */
export const EXIT_NOT_DEMONSTRATED = 1;

/** What one gated emit answers: the report, the emit failure, and the bytes. */
export interface GateRun {
  report: GateReport | null;
  emitError: Error | null;
  /** The emitted OpenAPI document as serialized, empty when the emit threw. */
  serialized: string;
}

/** Resolves one contract package by npm name, failing loudly when it is gone. */
export function contractPackage(name: string): ContractPackage {
  const found = contractPackages().find((pkg) => pkg.name === name);
  if (!found) throw new Error(`no contract package named ${name}`);
  return found;
}

/**
 * Runs gates 1-4 over a contract package, emitting from the contract rather
 * than reading the committed artifact — so a mutation to a schema module is
 * actually seen. Returns the report plus the emit failure, when gate 1 threw.
 *
 * The emit runs in a SEPARATE PROCESS, and that is load-bearing rather than
 * tidy. Bun caches a module by resolved path, and a cache-busting query string
 * on `emit.ts` does not reach the schema modules it imports — so an in-process
 * re-import after mutating `card.ts` returns the ORIGINAL schema and every
 * mutation reads as a no-op. Measured: the gates stayed green through a field
 * removal that oasdiff calls breaking. A fresh process is the only way to get a
 * fresh module graph.
 *
 * The serialized document comes back with the report because `runGates`
 * populates `report.document` only when it is handed a CONTRACT. Given a
 * `specPath` it leaves that field null, so a caller asserting on the emitted
 * shape through the report reads nothing and its assertion is vacuous.
 */
export async function gateContract(
  pkg: ContractPackage,
  scratchDir: string,
): Promise<GateRun> {
  const emitScript = path.join(pkg.dir, 'scripts', 'emit.ts');
  const driver = [
    `const m = await import(${JSON.stringify(emitScript)});`,
    'process.stdout.write(m.serializeDocument(m.buildDocument()));',
  ].join('\n');

  const child = Bun.spawnSync(['bun', '-e', driver], { cwd: REPO_ROOT });

  if (child.exitCode !== 0) {
    const message = new TextDecoder().decode(child.stderr)
      .trim();
    return { report: null, emitError: new Error(message || `emit exited ${child.exitCode}`), serialized: '' };
  }

  const serialized = new TextDecoder().decode(child.stdout);

  const specPath = path.join(scratchDir, `${path.basename(pkg.dir)}-${Date.now()}.json`);
  fs.writeFileSync(specPath, serialized, 'utf8');

  const report = await runGates({ contractPackageDir: pkg.dir, specPath });
  return { report, emitError: null, serialized };
}

/** True when every gate in the report passed. */
export function isGreen(result: GateRun): boolean {
  return result.emitError === null && result.report !== null && result.report.ok;
}

/** The gate that failed, or null when the run was green. */
export function failedGate(result: GateRun): GateName | 'emit' | null {
  if (result.emitError) return 'emit';
  return result.report?.failure?.gate ?? null;
}

/** Every reason string the failing gate reported, joined for substring checks. */
export function failureText(result: GateRun): string {
  if (result.emitError) return result.emitError.message;
  const failure = result.report?.failure;
  if (!failure) return '';
  return [failure.summary, ...failure.reasons].join('\n');
}

/**
 * Replaces one occurrence of `find` with `replace` in an absolute file path for
 * the duration of `body`, then restores the original bytes.
 *
 * Throws when `find` does not appear exactly once. A mutation helper that
 * silently no-ops when the source moved on is how an acceptance script starts
 * proving nothing while still exiting 0.
 */
export async function withReplacement<T>(
  absolutePath: string,
  find: string,
  replace: string,
  body: () => Promise<T>,
): Promise<T> {
  const original = fs.readFileSync(absolutePath, 'utf8');
  const hits = original.split(find).length - 1;

  if (hits !== 1) {
    throw new Error(
      `${path.relative(REPO_ROOT, absolutePath)}: expected exactly 1 occurrence of the mutation anchor, found ${hits}. `
      + 'The source moved; update the anchor rather than letting this script pass vacuously.',
    );
  }

  fs.writeFileSync(absolutePath, original.replace(find, replace), 'utf8');
  try {
    return await body();
  } finally {
    fs.writeFileSync(absolutePath, original, 'utf8');
  }
}

/** Adds a file for the duration of `body`, then removes it. */
export async function withAddedFile<T>(
  absolutePath: string,
  contents: string,
  body: () => Promise<T>,
): Promise<T> {
  if (fs.existsSync(absolutePath)) {
    throw new Error(`${path.relative(REPO_ROOT, absolutePath)} already exists; refusing to overwrite it`);
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, 'utf8');
  try {
    return await body();
  } finally {
    fs.rmSync(absolutePath, { force: true });
  }
}

/** One assertion in an acceptance script's narrative. */
export class Narrative {
  private failures = 0;

  constructor(private readonly title: string) {
    console.log(`\n${title}`);
    console.log('='.repeat(title.length));
  }

  step(description: string): void {
    console.log(`\n${description}`);
  }

  expect(claim: string, held: boolean, detail?: string): void {
    console.log(`  ${held
      ? 'OK  '
      : 'FAIL'}  ${claim}`);
    if (detail) {
      for (const line of detail.split('\n')) console.log(`          ${line}`);
    }
    if (!held) this.failures += 1;
  }

  finish(): number {
    if (this.failures === 0) {
      console.log(`\nDEMONSTRATED — ${this.title}`);
      return 0;
    }
    console.log(`\nNOT DEMONSTRATED — ${this.failures} assertion(s) failed`);
    return EXIT_NOT_DEMONSTRATED;
  }
}
