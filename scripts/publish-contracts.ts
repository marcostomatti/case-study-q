#!/usr/bin/env bun

/**
 * contracts:publish — write the published baseline for each contract package.
 *
 *   bun run contracts:publish            report what would change
 *   bun run contracts:publish --write    write the baselines
 *
 * "Publishing" here means committing `openapi/published/<version>.json`. There
 * is no npm registry in this PoC, so that file is the artifact a registry would
 * otherwise hold: it is what `oasdiff` diffs the next change against, and what
 * the version gate compares the emit to.
 *
 * This is a local script rather than a step that pushes from CI on merge. A
 * workflow writing to `main` needs `contents: write` on a public repository and
 * fights branch protection; a committed baseline is reviewable in the diff that
 * changes it — the same argument that makes the pin itself worth having.
 *
 * The release flow:
 *
 *   1. Change the contract and bump the package version.
 *   2. `bun run --filter <pkg> contracts:emit`  — refresh openapi/openapi.json
 *   3. `bun run pipeline:simulate`              — gate 3 diffs against the
 *                                                 CURRENT baseline, so a break
 *                                                 is caught before publishing
 *   4. `bun run contracts:publish --write`      — advance the baseline
 *   5. Commit all three, open the PR.
 *
 * Publishing before step 3 would move the baseline the diff gate compares
 * against, and every change would look non-breaking.
 */

import fs from 'node:fs';
import path from 'node:path';

import { latestPublishedSpec, publishedBaselinePath } from '@marcos-corp/contract-tooling';

import { contractPackages, REPO_ROOT, type ContractPackage } from './contractPackages';

/** Exit code when a baseline is missing and `--write` was not passed. */
const EXIT_UNPUBLISHED = 1;

const write = process.argv.includes('--write');

/** Emits a package's document out of process, so a stale module cache cannot lie. */
function emit(pkg: ContractPackage): string {
  const driver = [
    `const m = await import(${JSON.stringify(path.join(pkg.dir, 'scripts', 'emit.ts'))});`,
    'process.stdout.write(m.serializeDocument(m.buildDocument()));',
  ].join('\n');

  const child = Bun.spawnSync(['bun', '-e', driver], { cwd: REPO_ROOT });
  if (child.exitCode !== 0) {
    throw new Error(
      `${pkg.name}: emit failed — ${new TextDecoder().decode(child.stderr)
        .trim()}`,
    );
  }
  return new TextDecoder().decode(child.stdout);
}

function main(): number {
  let unpublished = 0;

  for (const pkg of contractPackages()) {
    const document = emit(pkg);
    const target = publishedBaselinePath(pkg.dir, pkg.version);
    const relative = path.relative(REPO_ROOT, target);

    if (fs.existsSync(target)) {
      const existing = fs.readFileSync(target, 'utf8');

      if (existing === document) {
        console.log(`  up to date  ${pkg.name}@${pkg.version} — ${relative}`);
        continue;
      }

      // A published version is immutable. Overwriting one is exactly the
      // failure the version gate exists to prevent: every consumer pinned at
      // this version would silently receive different bytes.
      console.error(
        `  REFUSED     ${pkg.name}@${pkg.version} — ${relative} already exists and differs.\n`
        + '              A published version is immutable. Bump the version instead.',
      );
      return EXIT_UNPUBLISHED;
    }

    const previous = latestPublishedSpec(pkg.dir);
    const from = previous === null
      ? '(first publish)'
      : path.basename(previous, '.json');

    if (!write) {
      console.log(`  would write ${pkg.name}@${pkg.version} — ${relative} (from ${from})`);
      unpublished += 1;
      continue;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, document, 'utf8');
    console.log(`  published   ${pkg.name}@${pkg.version} — ${relative} (from ${from})`);
  }

  if (unpublished > 0) {
    console.log(`\n${unpublished} baseline(s) not written. Re-run with --write.`);
    return EXIT_UNPUBLISHED;
  }

  console.log('\nEvery contract package has a published baseline for its declared version.');
  return 0;
}

process.exitCode = main();
