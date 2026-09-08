/**
 * Keeps the committed `openapi/openapi.json` honest.
 *
 * This package commits a generated file, which is the only way gate 3 has a
 * baseline to diff against without an npm registry. That buys the governance
 * chain one failure mode: the committed copy drifts from the schemas, every
 * later gate then reports on a contract nobody wrote, and the drift is
 * invisible — the artifact is read by no lint gate in this repo (the leaf
 * eslint config ignores `openapi/**`, the root one ignores `packages/**`, and
 * it is JSON so `tsc` never opens it either). This file is the check that
 * closes that, and a stale artifact fails CI here or nowhere.
 *
 * Two claims, deliberately in separate blocks:
 *
 * 1. **The committed bytes are the bytes a fresh emit writes.** Re-emitted
 *    through `./emit`'s own exports, never through a second copy of the
 *    metadata: a test that rebuilt `emitMeta` itself would compare the
 *    artifact against its own copy of those decisions and stay green while
 *    the two drifted apart. `serializeDocument` is half of the contract here —
 *    two-space JSON plus a trailing newline — so the formatting is the
 *    script's decision rather than this file's private opinion.
 * 2. **The emitted document passes every house rule.** Gate 2, run over this
 *    package's own document through the real `vacuum` and the real
 *    `house.spectral.yaml`, the same way `runGates` runs it in CI.
 *
 * The first block needs no binary and is scoped so a machine without `vacuum`
 * still fails on a stale artifact rather than skipping the case that matters
 * most in CI.
 *
 * ## Why the ruleset block carries six controls
 *
 * "vacuum reported nothing" is what a correct document and an unread document
 * both look like. A ruleset can report nothing forever — a `given` that
 * matches no node in *this* document is silent coverage loss, not an error.
 * So every rule in the ruleset is paired here with a mutation of the emitted
 * document that must make exactly that rule fire. The clean case is only worth
 * reading beside them.
 *
 * That is a sharper requirement here than in `contracts-service-a`, because
 * this document is a quarter the size: one operation, four components, and a
 * single enum outside the error catalogue. A rule whose `given` happens to
 * match nothing in a small document is exactly the silent pass these controls
 * exist to rule out, and there is far less here for it to match.
 *
 * The closure block is what keeps the pairing from rotting: a rule added to
 * the ruleset with no control here fails, and a control naming a rule the
 * ruleset no longer defines fails too.
 *
 * Scope, so the next reader does not go looking for it: this is one control
 * per **rule**, not per `then` entry. Rules 4, 5 and 6 each carry two legs and
 * both legs of each are covered by the per-rule fixtures in
 * `packages/contract-tooling/fixtures/violations/`, which is where the claim
 * "the rule is implemented correctly" lives. The claim here is narrower and is
 * the one those fixtures cannot make: every rule reads *this* document.
 *
 * `openapi/published/<version>.json` is deliberately not compared against the
 * working emit. A baseline is frozen at the version it was published under, so
 * on any pull request that bumps the version the two legitimately differ and
 * the new baseline does not exist yet. Keeping the published set in step with
 * the version belongs to the CI publish step on merge, not here.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HOUSE_RULESET_PATH, lintSpec } from '@marcos-corp/contract-tooling';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDocument, OPENAPI_DOCUMENT_PATH, serializeDocument } from './emit';

/** Two-space JSON, matching `serializeDocument`. Only used for mutated copies. */
const JSON_INDENT = 2;

/** The tail `OPENAPI_DOCUMENT_PATH` must resolve to, as a check on the path itself. */
const TRACKED_ARTIFACT_TAIL = join('packages', 'contracts-service-b', 'openapi', 'openapi.json');

/** The one operation this contract publishes, addressed by the controls below. */
const DUE_INVOICE_PATH = '/companies/{companyId}/due-invoice';

/**
 * Only the parts of the document the controls below reach into. Written as a
 * narrow local shape rather than borrowed from `openapi3-ts`: a control that
 * needs a key this interface does not name is a control editing something
 * nobody described, and the navigation helpers turn that into a message
 * instead of an `undefined`.
 */
interface MutableSchema {
  type?: unknown;
  enum?: string[];
  additionalProperties?: unknown;
  properties?: Record<string, MutableSchema>;
}

interface MutableOperation {
  operationId?: string;
  deprecated?: boolean;
}

interface MutableDocument {
  paths: Record<string, Record<string, MutableOperation>>;
  components: { schemas: Record<string, MutableSchema> };
}

interface HouseRuleControl {
  /** The rule id this mutation must make fire, and no other. */
  rule: string;
  /** Reads as the second half of the case name. */
  what: string;
  violate: (document: MutableDocument) => void;
}

/** The document `openapi/openapi.json` is supposed to hold, rebuilt from source. */
const freshBytes = (): string => serializeDocument(buildDocument());

/**
 * The committed artifact. Read inside a case rather than at module scope: a
 * throw out here would make every case in the file *vanish* instead of one
 * going red, and "the artifact is missing" is exactly the failure this file
 * exists to report.
 */
function readCommitted(): string {
  if (!existsSync(OPENAPI_DOCUMENT_PATH)) {
    throw new Error(
      `the committed OpenAPI document is missing from '${OPENAPI_DOCUMENT_PATH}'. `
      + 'Run `bun run contracts:emit` in this package and commit the result.',
    );
  }
  return readFileSync(OPENAPI_DOCUMENT_PATH, 'utf8');
}

/** A fresh deep copy of the emitted document, for one control to edit. */
const mutableCopy = (): MutableDocument => JSON.parse(freshBytes()) as MutableDocument;

function componentSchema(document: MutableDocument, name: string): MutableSchema {
  const found = document.components.schemas[name];
  if (!found) {
    throw new Error(`control cannot run: the emitted document has no component schema '${name}'`);
  }
  return found;
}

function componentProperty(
  document: MutableDocument,
  schemaName: string,
  propertyName: string,
): MutableSchema {
  const found = componentSchema(document, schemaName).properties?.[propertyName];
  if (!found) {
    throw new Error(
      `control cannot run: component schema '${schemaName}' has no property '${propertyName}'`,
    );
  }
  return found;
}

function operation(document: MutableDocument, path: string, method: string): MutableOperation {
  const found = document.paths[path]?.[method];
  if (!found) {
    throw new Error(`control cannot run: the emitted document has no ${method} ${path}`);
  }
  return found;
}

/**
 * One mutation per house rule. Each was measured against vacuum 0.30.3 and
 * this document: each reports its own rule code and no other, and the
 * unmutated document reports nothing at all.
 *
 * They edit a deep copy and are asserted to have changed it — a control whose
 * edit silently misses reports the same clean result as a passing document,
 * for entirely the wrong reason.
 */
const CONTROLS: HouseRuleControl[] = [
  {
    rule: 'house-no-typeless-schema',
    what: 'the `type` is deleted from the error payload\'s `message`',
    violate: (document) => {
      delete componentProperty(document, 'Error', 'message').type;
    },
  },
  {
    rule: 'house-object-additional-properties-explicit',
    what: '`additionalProperties` is deleted from `Invoice`',
    violate: (document) => {
      delete componentSchema(document, 'Invoice').additionalProperties;
    },
  },
  {
    rule: 'house-enum-has-unknown-member',
    what: 'the `unknown` member is dropped from the invoice payment state enum',
    violate: (document) => {
      const paymentState = componentProperty(document, 'Invoice', 'paymentState');
      paymentState.enum = (paymentState.enum ?? []).filter((member) => member !== 'unknown');
    },
  },
  {
    rule: 'house-deprecated-requires-sunset',
    what: 'the operation is marked deprecated with no `x-sunset` beside it',
    violate: (document) => {
      operation(document, DUE_INVOICE_PATH, 'get').deprecated = true;
    },
  },
  {
    rule: 'house-operation-id-and-shared-error-schema',
    what: 'the operation loses its `operationId`',
    violate: (document) => {
      delete operation(document, DUE_INVOICE_PATH, 'get').operationId;
    },
  },
  {
    rule: 'house-no-null',
    what: 'a field\'s `type` becomes a `["string", "null"]` array',
    violate: (document) => {
      componentProperty(document, 'Invoice', 'id').type = ['string', 'null'];
    },
  },
];

/**
 * Rule ids are the only keys at two-space indentation in the ruleset; every
 * key a rule owns sits at four or more. Same extractor as
 * `packages/contract-tooling/src/lint.test.ts`, and checked the same way
 * below — an extractor that quietly returned nothing would make both closure
 * cases pass vacuously.
 */
const rulesetRuleIds = (): string[] => {
  const source = readFileSync(HOUSE_RULESET_PATH, 'utf8');
  return [...source.matchAll(/^ {2}([A-Za-z][A-Za-z0-9-]*):[ \t]*$/gm)]
    .map((match) => match[1] ?? '');
};

describe('the committed openapi/openapi.json', () => {
  it('is the artifact this package tracks, not a path resolved somewhere else', () => {
    // Byte-identity against a file nobody ships proves nothing. Everything in
    // `./emit` resolves from `import.meta.url`, so this is what says the
    // resolution still lands in the tracked tree — and, because this script is
    // a near-copy of `contracts-service-a`'s, that it lands in *this* package's
    // tree rather than the one it was copied from.
    expect(OPENAPI_DOCUMENT_PATH.endsWith(TRACKED_ARTIFACT_TAIL)).toBe(true);
  });

  it('holds the document a fresh emit builds', () => {
    // The structural half, and it runs before the byte comparison on purpose:
    // this one names the node that drifted, where a whole-string diff does not.
    expect(JSON.parse(readCommitted())).toEqual(JSON.parse(freshBytes()));
  });

  it('is byte-identical to a fresh emit, so a stale artifact fails CI', () => {
    // The claim proper. Beyond the structural case it also covers the
    // serialization contract itself — key order, two-space indent and the
    // trailing newline — because those are what make re-emitting produce no
    // diff, which is the property a reviewer reads the artifact as having.
    expect(readCommitted()).toEqual(freshBytes());
  });
});

describe('the emitted document, against the house ruleset', () => {
  let scratchDir = '';
  let emittedBytes = '';
  let emittedSpecPath = '';

  beforeAll(async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'contracts-service-b-openapi-'));
    emittedBytes = freshBytes();
    emittedSpecPath = join(scratchDir, 'openapi.json');
    writeFileSync(emittedSpecPath, emittedBytes);

    // One pointed failure beats eight identical ones. `vacuum` is a documented
    // prerequisite, not something this suite can install, and this block is
    // scoped so a machine without it still runs the byte-identity cases above.
    await lintSpec(emittedSpecPath);
  });

  afterAll(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('reports nothing at all', async () => {
    const result = await lintSpec(emittedSpecPath);

    // `findings`, not `errors`: a rule added at `warn` would not block the
    // gate, and this document should not be tripping one silently either.
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each(CONTROLS)('$rule fires when $what', async ({ rule, violate }) => {
    const mutated = mutableCopy();
    violate(mutated);

    // The load-bearing line. A control whose edit missed produces a document
    // that lints clean, and a clean result is indistinguishable from the
    // mutation never having applied.
    expect(mutated).not.toEqual(JSON.parse(emittedBytes));

    const specPath = join(scratchDir, `${rule}.json`);
    writeFileSync(specPath, `${JSON.stringify(mutated, null, JSON_INDENT)}\n`);
    const result = await lintSpec(specPath);

    expect(result.ok).toBe(false);
    // The code SET, never a count: vacuum resolves `$ref` before a rule runs,
    // so one violation on a referenced schema is reported more than once —
    // deleting `additionalProperties` from `Invoice` yields two findings.
    expect([...new Set(result.errors.map((finding) => finding.code))]).toEqual([rule]);
  });
});

describe('ruleset and control closure', () => {
  it('extracts the rule ids and nothing else', () => {
    const ids = rulesetRuleIds();

    expect(ids.length).toBeGreaterThan(0);
    // The negative control. If the indentation assumption breaks, these are
    // the keys that leak in, and both closure cases below would then pass or
    // fail for reasons that have nothing to do with coverage.
    expect(ids).not.toContain('description');
    expect(ids).not.toContain('severity');
    expect(ids).not.toContain('given');
    expect(ids).not.toContain('then');
    expect(ids.every((id) => id.startsWith('house-'))).toBe(true);
  });

  it('has a control for every rule in the ruleset', () => {
    const covered = new Set(CONTROLS.map((control) => control.rule));
    const uncovered = rulesetRuleIds().filter((id) => !covered.has(id));

    // A rule with no control against this document is coverage that reads as
    // present and is not: the clean case would stay green whether or not that
    // rule ever looked at anything here. This document is small enough that
    // that is a live risk rather than a theoretical one.
    expect(uncovered).toEqual([]);
  });

  it('has no control naming a rule the ruleset does not define', () => {
    const defined = new Set(rulesetRuleIds());
    const orphaned = CONTROLS.map((control) => control.rule).filter((rule) => !defined.has(rule));

    // A control whose rule was renamed still fires nothing and still passes
    // its own case, because the mutation is asserted against its own expected
    // code rather than against the ruleset.
    expect(orphaned).toEqual([]);
  });
});
