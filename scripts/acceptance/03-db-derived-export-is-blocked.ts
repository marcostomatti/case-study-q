#!/usr/bin/env bun

/**
 * Acceptance criterion 3 (spec §9.3):
 *
 *   "A PR that exports a Drizzle-derived schema from a contract package is
 *    blocked by CI."
 *
 * This is spec §2.1's headline rule — never derive an API schema from a
 * database table — and the reason the rule exists is that deriving publishes
 * the database to every consumer and turns every migration into a potential
 * contract break.
 *
 * The script adds exactly the module a well-meaning developer would write, and
 * requires the dependency gate to reject it and name the import.
 *
 *   bun scripts/acceptance/03-db-derived-export-is-blocked.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assertNoDbImport, DB_PACKAGE_NAME } from '@marcos-corp/contract-tooling';

import { contractPackage, Narrative, withAddedFile } from './harness';

/** The tempting module: a contract schema generated straight off the table. */
const DERIVED_MODULE = `/**
 * The module spec §2.1 forbids: a contract schema derived from a table.
 * Written by this acceptance script, removed before it exits.
 */

import { createSelectSchema } from 'drizzle-typebox';

import { companies } from '${DB_PACKAGE_NAME}';

export const CompanyFromTable = createSelectSchema(companies);
`;

const story = new Narrative('Acceptance 3 — a Drizzle-derived contract export is blocked');

const pkg = contractPackage('@marcos-corp/contracts-service-a');
const offendingModule = path.join(pkg.dir, 'src', 'schemas', 'companyFromTable.ts');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-03-'));

try {
  story.step('Control: the untouched contract package imports no database module.');
  const before = assertNoDbImport(pkg.dir);
  story.expect(
    'the dependency gate reports no findings',
    before.length === 0,
    before.map((f) => f.message).join('\n'),
  );

  story.step(`Mutation: add a schema derived from a Drizzle table via \`${DB_PACKAGE_NAME}\`.`);
  await withAddedFile(offendingModule, DERIVED_MODULE, async () => {
    const findings = assertNoDbImport(pkg.dir);

    story.expect('the dependency gate rejects the package', findings.length > 0);

    const text = findings.map((f) => f.message).join('\n');
    story.expect(
      `the message names \`${DB_PACKAGE_NAME}\``,
      text.includes(DB_PACKAGE_NAME),
      text,
    );
    story.expect(
      'the message names the offending file',
      text.includes('companyFromTable.ts'),
      text.includes('companyFromTable.ts')
        ? undefined
        : text,
    );
  });

  story.step('Restore: the offending module is gone.');
  story.expect('companyFromTable.ts no longer exists', !fs.existsSync(offendingModule));
  story.expect('the dependency gate is clean again', assertNoDbImport(pkg.dir).length === 0);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

process.exitCode = story.finish();
