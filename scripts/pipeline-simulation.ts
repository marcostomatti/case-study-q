#!/usr/bin/env bun

/**
 * pipeline-simulation — the spec §8 gates, run locally, in order.
 *
 *   bun run pipeline:simulate
 *
 * Runs the four blocking gates over every contract package, then the pin gate
 * over every consuming package, and exits non-zero on the first failure.
 *
 * This exists so the governance story is demonstrable without GitHub. The CI
 * contracts job runs the same composition over the same packages, so a green
 * run here predicts a green run there — with one gap worth naming: CI pins the
 * gate binary versions and a workstation does not, so a locally newer `vacuum`
 * can report a rule violation CI never sees. The versions CI installs are in
 * `.github/workflows/ci.yml`.
 *
 * Gate 1 runs for real rather than trusting the committed artifact. Each
 * contract package's `buildDocument()` is called, and gates 2 and 3 read what
 * it produced — not `openapi/openapi.json`. That ordering matters: linting the
 * committed file would pass while the contract that generates it was already
 * broken. The committed artifact is separately compared against the fresh emit,
 * so drift is reported as drift rather than hiding behind a green lint.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runGates, assertExactContractPins, type GateReport } from '@marcos-corp/contract-tooling';

import { consumingPackages, contractPackages, type ContractPackage } from './contractPackages';

/** Exit code for a gate failure, as opposed to a crash. */
const EXIT_GATE_FAILED = 1;

const PASS = '  PASS';
const FAIL = '  FAIL';
const SKIP = '  SKIP';

interface EmitModule {
  buildDocument: () => unknown;
  serializeDocument: (document: never) => string;
}

/**
 * Emits a contract package's document to a scratch file and answers both that
 * path and whether the committed artifact still matches.
 *
 * A throw from `buildDocument()` is gate 1 failing, which is the whole point of
 * running it here: an unrepresentable schema must stop the pipeline before
 * anything reads a document built from it.
 */
async function emitToScratch(
  pkg: ContractPackage,
  scratchDir: string,
): Promise<{ specPath: string; committedMatches: boolean }> {
  const emit = (await import(path.join(pkg.dir, 'scripts', 'emit.ts'))) as EmitModule;

  const document = emit.buildDocument();
  const serialized = emit.serializeDocument(document as never);

  const specPath = path.join(scratchDir, `${path.basename(pkg.dir)}.json`);
  fs.writeFileSync(specPath, serialized, 'utf8');

  const committed = fs.existsSync(pkg.specPath)
    ? fs.readFileSync(pkg.specPath, 'utf8')
    : null;

  return { specPath, committedMatches: committed === serialized };
}

function renderReport(report: GateReport): void {
  for (const outcome of report.outcomes) {
    // `runGates` reports emit as skipped when handed a document rather than a
    // contract. It is not skipped here — it ran against the real contract
    // above, and printing a SKIP line for it would say the opposite.
    if (outcome.gate === 'emit') continue;

    const mark = outcome.status === 'passed'
      ? PASS
      : outcome.status === 'failed'
        ? FAIL
        : SKIP;
    console.log(`${mark}  ${outcome.gate.padEnd(10)} ${outcome.summary}`);

    // Only a failure's reasons earn the vertical space; a passing gate's detail
    // is noise in a demo.
    if (outcome.status === 'failed') {
      for (const reason of outcome.reasons) console.log(`          ${reason}`);
    }
  }
}

async function main(): Promise<number> {
  console.log('Contract gates — spec §8 order: emit -> lint -> diff -> dependency');

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-simulation-'));
  let failed = false;

  try {
    for (const pkg of contractPackages()) {
      const heading = `${pkg.name}@${pkg.version}`;

      let emitted: { specPath: string; committedMatches: boolean };
      try {
        emitted = await emitToScratch(pkg, scratchDir);
      } catch (error) {
        // Gate 1 rejected the contract. Gates 2-4 have nothing to read, so stop
        // this package here rather than reporting three misleading skips.
        failed = true;
        console.log(`\n${heading}`);
        console.log(`${FAIL}  emit       ${error instanceof Error
          ? error.message
          : String(error)}`);
        continue;
      }

      console.log(`\n${heading}`);
      console.log(`${PASS}  emit       the contract emitted a representable document`);

      if (!emitted.committedMatches) {
        failed = true;
        console.log(`${FAIL}  artifact   ${path.relative(pkg.dir, pkg.specPath)} differs from a fresh emit`);
        console.log('          run the package\'s contracts:emit script and commit the result');
      }

      const report = await runGates({
        contractPackageDir: pkg.dir,
        specPath: emitted.specPath,
      });

      renderReport(report);
      if (!report.ok) failed = true;
    }
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }

  console.log('\nPin gate — spec §2.2: exact versions, no ranges');

  for (const pkg of consumingPackages()) {
    const findings = assertExactContractPins(pkg.dir);

    if (findings.length === 0) {
      // A package with no contract dependency also reports zero findings, so a
      // green line here is not by itself evidence the gate read a pin.
      console.log(`${PASS}  ${pkg.name}`);
      continue;
    }

    failed = true;
    console.log(`${FAIL}  ${pkg.name}`);
    for (const finding of findings) {
      console.log(`          ${finding.packageName}: ${finding.specifier} — ${finding.message}`);
    }
  }

  if (failed) {
    console.log('\nFAILED — at least one gate rejected the working tree.');
    return EXIT_GATE_FAILED;
  }

  console.log('\nPASSED — every gate green.');
  return 0;
}

process.exitCode = await main();
