#!/usr/bin/env bun

/**
 * Acceptance criterion 1 (spec §9.1) and the spec §6.1 unblocking workflow:
 *
 *   "A consumer PR adds a field to `contracts-service-a`, CI passes, provider
 *    approves, and `web-b` builds against a mock of the new version with zero
 *    backend code written."
 *
 * The half this script owns is the CI half: a consumer-authored ADDITIVE field
 * passes every gate, where §9.2's removal does not. The mock half is
 * `scripts/demo.ts`, which serves the emitted document through Prism — no
 * `service-a` handler is written for the new field in either place, which is
 * the entire point.
 *
 *   bun scripts/acceptance/01-consumer-adds-field.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  contractPackage,
  failureText,
  gateContract,
  isGreen,
  Narrative,
  withReplacement,
} from './harness';

const ADDED_FIELD = 'organisationNumber';

/** Anchored on the closing brace of CompanySummary's property map. */
const ANCHOR = `  name: Type.String({
    description: 'The company name the selector renders.',
    minLength: 1,
    examples: ['Company AB'],
  }),
`;

const ADDITION = `${ANCHOR}  organisationNumber: Type.Optional(Type.String({
    description: 'Swedish organisation number, as the registry spells it.',
    minLength: 1,
    examples: ['556677-8899'],
  })),
`;

const story = new Narrative('Acceptance 1 — a consumer-authored additive field passes CI');

const pkg = contractPackage('@marcos-corp/contracts-service-a');
const companySchema = path.join(pkg.dir, 'src', 'schemas', 'company.ts');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-01-'));

try {
  story.step('Control: the untouched contract passes every gate.');
  const before = await gateContract(pkg, scratch);
  story.expect('gates are green before the addition', isGreen(before), isGreen(before)
    ? undefined
    : failureText(before));

  story.step(`Consumer PR: add an optional \`${ADDED_FIELD}\` to CompanySummary.`);
  await withReplacement(companySchema, ANCHOR, ADDITION, async () => {
    const after = await gateContract(pkg, scratch);

    story.expect(
      'gates ACCEPT the addition — additive is not breaking',
      isGreen(after),
      isGreen(after)
        ? undefined
        : failureText(after),
    );

    // Without this, "the gates passed" is consistent with the mutation never
    // having been applied — which is exactly the failure the §9.2 control
    // caught during development.
    story.expect(
      `the emitted document actually carries \`${ADDED_FIELD}\``,
      after.serialized.includes(ADDED_FIELD),
      after.serialized.includes(ADDED_FIELD)
        ? undefined
        : 'the gates passed a document the mutation never reached',
    );
  });

  story.step('Restore: the working tree is back to its committed state.');
  story.expect(
    'company.ts no longer carries the proposed field',
    !fs.readFileSync(companySchema, 'utf8').includes(ADDED_FIELD),
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

process.exitCode = story.finish();
