#!/usr/bin/env bun

/**
 * Acceptance criterion 2 (spec §9.2):
 *
 *   "A PR that removes a field from `contracts-service-a` is blocked by CI
 *    with a readable message naming the break."
 *
 * Removes `artUrl` from the published `Card` schema, re-emits, and requires the
 * diff gate to reject it and to name the field.
 *
 *   bun scripts/acceptance/02-removal-is-blocked.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  contractPackage,
  failedGate,
  failureText,
  gateContract,
  isGreen,
  Narrative,
  withReplacement,
} from './harness';

const REMOVED_FIELD = 'artUrl';

/** The whole property, anchored on text that appears exactly once in the file. */
const CARD_ART_PROPERTY = `  artUrl: Type.String({
    description: 'Absolute URL of the card artwork, resolved by the provider.',
    format: 'uri',
    minLength: 1,
    examples: ['https://cdn.example.com/card-art/business-black-v2.png'],
  }),
`;

const story = new Narrative('Acceptance 2 — removing a published field is blocked');

const pkg = contractPackage('@marcos-corp/contracts-service-a');
const cardSchema = path.join(pkg.dir, 'src', 'schemas', 'card.ts');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-02-'));

try {
  story.step('Control: the untouched contract passes every gate.');
  const before = await gateContract(pkg, scratch);
  story.expect(
    'gates are green before the removal',
    isGreen(before),
    isGreen(before)
      ? undefined
      : failureText(before),
  );

  story.step(`Mutation: remove \`${REMOVED_FIELD}\` from the published Card schema.`);
  await withReplacement(cardSchema, CARD_ART_PROPERTY, '', async () => {
    const after = await gateContract(pkg, scratch);

    story.expect('gates reject the removal', !isGreen(after));
    story.expect(
      'the DIFF gate is what rejected it, not lint or emit',
      failedGate(after) === 'diff',
      `failing gate: ${failedGate(after) ?? 'none'}`,
    );

    const text = failureText(after);
    story.expect(
      `the message names the removed field (\`${REMOVED_FIELD}\`)`,
      text.includes(REMOVED_FIELD),
      text,
    );
  });

  story.step('Restore: the working tree is back to its committed state.');
  story.expect(
    'card.ts contains artUrl again',
    fs.readFileSync(cardSchema, 'utf8').includes(CARD_ART_PROPERTY),
  );

  const restored = await gateContract(pkg, scratch);
  story.expect('gates are green again', isGreen(restored), isGreen(restored)
    ? undefined
    : failureText(restored));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

process.exitCode = story.finish();
