/**
 * Gate 3 of the four blocking gates in spec section 8: diff a contract's
 * working OpenAPI emit against its highest published baseline and report the
 * breaking changes.
 *
 * This shells out to `oasdiff`, the Go binary the plan names. Four measured
 * behaviours of oasdiff 1.31.0 shape everything below, and three of them
 * produce a gate that silently never fails if they are ignored:
 *
 *   1. `oasdiff breaking` exits **0 whether or not it found breaking
 *      changes**, unless `--fail-on` is passed. A wrapper that reads the exit
 *      code is a gate that can never block a pull request. Pass/fail is
 *      derived from the parsed report here, which also leaves the exit code
 *      free to mean only one thing: the gate could not run.
 *   2. Removing an **optional** response property is not a breaking change.
 *      Only a required one is. "The diff gate catches removals" is therefore
 *      false as stated, and `fixtures/diff/not-breaking/` pins the half that
 *      is easy to assume away.
 *   3. Narrowing is breaking in the **request** direction only. Tightening a
 *      response property from `number` to `integer` is reported as nothing;
 *      the same edit on a request property is reported as an error, because
 *      it shrinks what the provider accepts from a consumer already deployed.
 *   4. A document that is valid YAML but is not an OpenAPI description parses
 *      without complaint and reports every path as removed. That fails in the
 *      safe direction — maximally breaking rather than silently clean — but
 *      nothing here can tell it apart from a real mass removal. Gate order in
 *      spec section 8 is what covers it: emit and lint both run first.
 *
 * Load failures (a missing or unparseable spec on either side) exit 102 and
 * name the offending file on stderr. Every one of them is thrown rather than
 * returned, which is the same split `lintSpec` and `tools/control-byte-gate`
 * make: the thing under test being bad is a returned result, the gate being
 * unable to run is a throw. A diff that could not be computed must never be
 * mistaken for a diff that found nothing.
 */
import type { BinaryRun } from './runBinary';

import { existsSync } from 'node:fs';

import { runBinary } from './runBinary';

/**
 * oasdiff's severity levels, keyed by the integer its JSON report carries.
 * `oasdiff breaking` emits only levels it considers breaking, so in practice
 * this is `error` and `warning`; `info` is listed because the numbering
 * belongs to oasdiff and not to this gate.
 */
const LEVEL_BY_ORDINAL: Readonly<Record<number, BreakingChangeLevel>> = {
  1: 'info',
  2: 'warning',
  3: 'error',
};

export type BreakingChangeLevel = 'error' | 'warning' | 'info';

/** Where a change sits in one of the two documents. */
export interface ChangeLocation {
  file: string;
  /** 1-based. Absent when oasdiff had no line to point at. */
  line?: number;
  /** 1-based. Absent for the same reason as `line`. */
  column?: number;
}

export interface BreakingChange {
  /** The oasdiff check id, e.g. `response-required-property-removed`. */
  id: string;
  /** oasdiff's rendered sentence, naming the field and the status code. */
  text: string;
  /** oasdiff's extra rationale. Present on some checks only. */
  comment?: string;
  level: BreakingChangeLevel;
  /** HTTP method, when the change is attributable to one operation. */
  operation?: string;
  /** The operation's `operationId` — the key `api_usage` rows are grouped by. */
  operationId?: string;
  /** Templated path, e.g. `/companies/{companyId}/dashboard`. */
  path?: string;
  /** Which part of the document changed, e.g. `paths`. */
  section?: string;
  /** Where the change is in the baseline. Absent for a pure addition. */
  base?: ChangeLocation;
  /** Where the change is in the revision. Absent for a pure removal. */
  revision?: ChangeLocation;
}

export interface DiffResult {
  /**
   * True when `changes` is non-empty.
   *
   * `oasdiff breaking` reports breaking changes and nothing else, so every
   * entry blocks — including the warning-level ones, which oasdiff describes
   * as breaking for *some* clients. Filtering those out would let
   * `request-parameter-removed` through a gate whose whole purpose is to
   * catch it.
   */
  breaking: boolean;
  changes: BreakingChange[];
}

export interface DiffOptions {
  /** Defaults to `$OASDIFF_BIN`, else `oasdiff` from `PATH`. */
  oasdiffBin?: string;
}

function toLocation(raw: unknown): ChangeLocation | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;

  const file = rec['file'];
  if (typeof file !== 'string') return undefined;

  const line = rec['line'];
  const column = rec['column'];
  return {
    file,
    ...(typeof line === 'number'
      ? { line }
      : {}),
    ...(typeof column === 'number'
      ? { column }
      : {}),
  };
}

function toChange(raw: unknown): BreakingChange {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`oasdiff reported a change that is not an object: ${JSON.stringify(raw)}`);
  }
  const rec = raw as Record<string, unknown>;

  const id = rec['id'];
  const text = rec['text'];
  if (typeof id !== 'string' || typeof text !== 'string') {
    throw new Error(`oasdiff reported a change with no id or text: ${JSON.stringify(raw)}`);
  }

  const levelOrdinal = rec['level'];
  // An unrecognised level falls back to `error` on purpose, matching
  // `lintSpec`. Guessing "probably only informational" is how a real break
  // stops blocking.
  const level = typeof levelOrdinal === 'number'
    ? LEVEL_BY_ORDINAL[levelOrdinal] ?? 'error'
    : 'error';

  const optionalString = (key: string): Record<string, string> => {
    const value = rec[key];
    return typeof value === 'string' && value.length > 0
      ? { [key]: value }
      : {};
  };

  const base = toLocation(rec['baseSource']);
  const revision = toLocation(rec['revisionSource']);

  return {
    id,
    text,
    level,
    ...optionalString('comment'),
    ...optionalString('operation'),
    ...optionalString('operationId'),
    ...optionalString('path'),
    ...optionalString('section'),
    ...(base === undefined
      ? {}
      : { base }),
    ...(revision === undefined
      ? {}
      : { revision }),
  };
}

/** oasdiff writes a plain `Error: ...` line to stderr; stdout stays empty. */
function failureText(run: BinaryRun): string {
  const stderr = run.stderr.trim();
  if (stderr.length > 0) return stderr;
  return run.stdout.trim();
}

/**
 * Reports the breaking changes between a published baseline and a revision.
 *
 * `basePath` is the contract as consumers have it today — in this repo, the
 * highest document under a contract package's `openapi/published/`.
 * `revisionPath` is the working emit the pull request proposes.
 *
 * Returns `breaking: false` with an empty `changes` list when the revision is
 * safe to publish. Throws when the diff itself could not be computed: a
 * missing binary, a spec that does not exist or does not parse, or output
 * oasdiff was not expected to produce.
 */
export async function diffSpecs(
  basePath: string,
  revisionPath: string,
  options: DiffOptions = {},
): Promise<DiffResult> {
  const bin = options.oasdiffBin ?? process.env['OASDIFF_BIN'] ?? 'oasdiff';

  // Checked here rather than left to oasdiff, which reports a missing file
  // and an unparseable one with the same exit 102 and separates them only by
  // message wording. Branching on wording would break on an upgrade, and
  // "which side is missing" is the first thing a human needs.
  if (!existsSync(basePath)) {
    throw new Error(`diff gate cannot run: base spec not found at '${basePath}'`);
  }
  if (!existsSync(revisionPath)) {
    throw new Error(`diff gate cannot run: revision spec not found at '${revisionPath}'`);
  }

  // No `--color` flag: oasdiff rejects it outright under `-f json` (exit 100,
  // "only relevant with 'text' or 'singleline' formats"). It is not needed
  // either — the JSON report carries no colour, and the stderr this reads for
  // failure text is plain.
  const run = await runBinary(
    bin,
    ['breaking', basePath, revisionPath, '-f', 'json'],
    { gate: 'diff', envVar: 'OASDIFF_BIN' },
  );

  if (run.code !== 0) {
    throw new Error(`diff gate cannot run: ${bin} exited ${run.code}: ${failureText(run)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch (cause) {
    throw new Error(
      `diff gate cannot run: ${bin} exited 0 but did not emit JSON comparing `
      + `'${basePath}' with '${revisionPath}'`,
      { cause },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `diff gate cannot run: ${bin} emitted ${typeof parsed}, expected an array of changes`,
    );
  }

  const changes = parsed.map((raw) => toChange(raw));
  return { breaking: changes.length > 0, changes };
}
