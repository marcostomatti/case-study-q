#!/usr/bin/env bun

/**
 * Acceptance criterion 5 (spec §9.5):
 *
 *   "`service-b` consumes `contracts-service-a` at a pinned version, and
 *    bumping that pin is a reviewable PR."
 *
 * Two claims, and they are separate:
 *
 *   1. The pin is EXACT. A range specifier is rejected by the pin gate, which
 *      is what stops a consumer from silently drifting onto a new contract.
 *   2. Bumping it is REVIEWABLE — the change is one line in one manifest, on a
 *      path CODEOWNERS routes to the provider team.
 *
 * `service-b` is the interesting consumer precisely because it is also a
 * provider: spec §1 requires it so the design has to show that today's provider
 * is tomorrow's consumer, reviewed through exactly the same path an app is.
 *
 *   bun scripts/acceptance/05-pin-bump-is-reviewable.ts
 */

import fs from 'node:fs';
import path from 'node:path';

import { assertExactContractPins } from '@marcos-corp/contract-tooling';

import { REPO_ROOT } from '../contractPackages';

import { Narrative, withReplacement } from './harness';

const CONSUMER_DIR = path.join(REPO_ROOT, 'services', 'service-b');
const MANIFEST = path.join(CONSUMER_DIR, 'package.json');
const CODEOWNERS = path.join(REPO_ROOT, '.github', 'CODEOWNERS');

const EXACT_PIN = '"@marcos-corp/contracts-service-a": "0.1.0"';
const RANGE_PIN = '"@marcos-corp/contracts-service-a": "^0.1.0"';
const BUMPED_PIN = '"@marcos-corp/contracts-service-a": "0.2.0"';

const story = new Narrative('Acceptance 5 — a contract pin is exact, and bumping it is reviewable');

story.step('Control: service-b pins the contract it consumes exactly.');
const before = assertExactContractPins(CONSUMER_DIR);
story.expect(
  'the pin gate reports no findings',
  before.length === 0,
  before.map((f) => f.message).join('\n'),
);
story.expect(
  'the manifest carries an exact version, with no range specifier',
  fs.readFileSync(MANIFEST, 'utf8').includes(EXACT_PIN),
);

story.step('Mutation: relax the pin to a caret range, the way a well-meaning bump would.');
await withReplacement(MANIFEST, EXACT_PIN, RANGE_PIN, async () => {
  const findings = assertExactContractPins(CONSUMER_DIR);

  story.expect('the pin gate rejects the range', findings.length > 0);

  const text = findings.map((f) => f.message).join('\n');
  story.expect(
    'the message names the offending specifier',
    text.includes('^0.1.0'),
    text,
  );
});

story.step('Mutation: bump the pin to an exact new version, the way an adoption PR would.');
await withReplacement(MANIFEST, EXACT_PIN, BUMPED_PIN, async () => {
  story.expect(
    'the pin gate accepts an exact bump',
    assertExactContractPins(CONSUMER_DIR).length === 0,
  );

  // "Reviewable" is a property of the diff, so read the diff rather than
  // asserting it in prose: one file, one line changed.
  const diff = Bun.spawnSync(['git', 'diff', '--numstat', '--', 'services/service-b/package.json'], { cwd: REPO_ROOT });
  const numstat = new TextDecoder().decode(diff.stdout)
    .trim();
  story.expect(
    'the adoption diff is one added and one removed line in one manifest',
    numstat.startsWith('1\t1\t'),
    numstat || '(no diff recorded)',
  );
});

story.step('Ownership: the reviewed path routes to the provider team.');
const codeowners = fs.existsSync(CODEOWNERS)
  ? fs.readFileSync(CODEOWNERS, 'utf8')
  : '';
story.expect(
  'CODEOWNERS assigns packages/contracts-service-a/',
  codeowners.includes('packages/contracts-service-a/'),
);

story.step('Restore: the manifest is back to its committed pin.');
story.expect('service-b pins 0.1.0 exactly again', fs.readFileSync(MANIFEST, 'utf8').includes(EXACT_PIN));
story.expect('the pin gate is clean again', assertExactContractPins(CONSUMER_DIR).length === 0);

process.exitCode = story.finish();
