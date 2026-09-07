/**
 * Gate 2 of the four blocking gates in spec section 8: lint a contract's
 * emitted OpenAPI document against the house ruleset.
 *
 * This shells out to `vacuum`, the Spectral-ruleset-compatible Go binary the
 * plan names, and turns its report into a typed result. Four vacuum
 * behaviours shape everything below. Each was measured against vacuum 0.30.3
 * rather than assumed, and each produces a wrapper that silently never fails
 * if it is ignored:
 *
 *   1. `vacuum lint` sets an exit code but emits no JSON — it has no output
 *      flag at all. The machine-readable subcommand is
 *      `spectral-report -r <ruleset> -o <spec>`, where `-o` is a boolean
 *      meaning "write to stdout", not "the output file".
 *   2. `spectral-report` exits 0 whether or not it found anything, so
 *      pass/fail has to be derived from the parsed array. A wrapper that
 *      reads the exit code is a gate that can never fail.
 *   3. On a document it cannot parse it exits 2 and writes an ANSI-coloured
 *      banner to stdout, so `JSON.parse(stdout)` throws rather than returning
 *      an empty list. That third outcome is the one a naive wrapper drops.
 *   4. A ruleset whose rules are nonsense (an unknown function, a `given`
 *      that matches nothing) still exits 0 with `[]`. Nothing here can detect
 *      that; it is what `lint.test.ts` and the per-rule fixtures are for.
 *
 * Exit-2 has two causes that must not be conflated: the document under test
 * did not parse (a real finding about that document), or the gate itself
 * could not run (missing or malformed ruleset, missing binary). The first is
 * returned as a finding; the second throws. That mirrors
 * `tools/control-byte-gate`, where exit 1 means "the thing under test is bad"
 * and exit 2 means "the gate could not run" — a gate that cannot run must
 * never be mistaken for a gate that passed.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The house ruleset, resolved relative to this module so a caller in any
 * working directory gets the same file. Every contract package in this repo
 * lints against exactly this ruleset; `LintOptions.rulesetPath` exists for
 * tests that need a deliberately different one.
 */
export const HOUSE_RULESET_PATH = fileURLToPath(
  new URL('../rulesets/house.spectral.yaml', import.meta.url),
);

/**
 * Code carried by the synthetic finding reported when the document under
 * test does not parse. Deliberately not prefixed `house-`: it is not a house
 * rule, and a caller grouping findings by rule should be able to tell them
 * apart without a table.
 */
export const SPEC_PARSE_FAILED = 'spec-parse-failed';

/** Spectral severities, in the ordinal order vacuum reports them. */
const SEVERITY_BY_ORDINAL: readonly LintSeverity[] = ['error', 'warn', 'info', 'hint'];

/**
 * Built from its code point rather than written as an escape: a literal ESC
 * byte in a source file is exactly what `gate:control-bytes` and
 * `house/no-unsafe-unicode` reject, and a four-hex backslash-u escape is
 * valid JSON, so an agent write path can collapse it to the real byte before
 * the file reaches disk.
 */
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export type LintSeverity = 'error' | 'warn' | 'info' | 'hint';

export interface LintFinding {
  /** The rule that fired, e.g. `house-no-null`. */
  code: string;
  /** Document path to the offending node, as vacuum resolved it. */
  path: string[];
  /** `<rule description>: <function message>` — vacuum joins the two. */
  message: string;
  severity: LintSeverity;
  /**
   * 1-based line in the linted document. Absent when there is no line to
   * point at, which is the case for the parse-failure finding. It is the
   * field to show a human: vacuum reports a correct line even where it
   * cannot render a path.
   */
  line?: number;
  /** The document the finding is against. */
  source: string;
}

export interface LintResult {
  /** True when nothing at error severity fired. */
  ok: boolean;
  /** The blocking subset of `findings` — severity `error` only. */
  errors: LintFinding[];
  /** Everything vacuum reported, at every severity. */
  findings: LintFinding[];
}

export interface LintOptions {
  /** Defaults to {@link HOUSE_RULESET_PATH}. */
  rulesetPath?: string;
  /** Defaults to `$VACUUM_BIN`, else `vacuum` from `PATH`. */
  vacuumBin?: string;
}

interface VacuumRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs vacuum and collects both streams. Resolves for any exit code — the
 * caller decides which ones mean what — and rejects only when the process
 * could not be started at all.
 */
function runVacuum(bin: string, args: readonly string[]): Promise<VacuumRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args]);
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (cause: Error & { code?: string }) => {
      if (cause.code === 'ENOENT') {
        reject(new Error(
          `lint gate cannot run: could not execute '${bin}'. vacuum is a documented `
          + 'prerequisite (see .plans/PREREQUISITES-01-bare-minimal-api-governance-poc.md); '
          + 'install it on PATH, or point $VACUUM_BIN at it.',
          { cause },
        ));
        return;
      }
      reject(cause);
    });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });

    // vacuum only reads stdin under `-i`, but a pipe left open is a way to
    // hang on a future version that probes it.
    child.stdin.end();
  });
}

/** Prefers vacuum's plain stderr line over its ANSI-coloured stdout banner. */
function failureText(run: VacuumRun): string {
  const stderr = run.stderr.trim();
  if (stderr.length > 0) return stderr;
  return run.stdout.replace(ANSI_SGR, '').trim();
}

function toFinding(raw: unknown, specPath: string): LintFinding {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`vacuum reported a finding that is not an object: ${JSON.stringify(raw)}`);
  }
  const rec = raw as Record<string, unknown>;

  const code = rec['code'];
  const message = rec['message'];
  if (typeof code !== 'string' || typeof message !== 'string') {
    throw new Error(
      `vacuum reported a finding with no code or message: ${JSON.stringify(raw)}`,
    );
  }

  const rawPath = rec['path'];
  const path = Array.isArray(rawPath)
    ? rawPath.map((segment) => String(segment))
    : [];

  const severityOrdinal = rec['severity'];
  // An unrecognised severity falls back to `error` on purpose. Guessing
  // "probably just a hint" is how a real violation stops blocking.
  const severity = typeof severityOrdinal === 'number'
    ? SEVERITY_BY_ORDINAL[severityOrdinal] ?? 'error'
    : 'error';

  const range = rec['range'];
  const start = typeof range === 'object' && range !== null
    ? (range as Record<string, unknown>)['start']
    : undefined;
  const line = typeof start === 'object' && start !== null
    ? (start as Record<string, unknown>)['line']
    : undefined;

  const source = rec['source'];

  return {
    code,
    path,
    message,
    severity,
    // Omitted rather than defaulted to 0: a synthetic line number reads as a
    // real place in the document and sends a human to the wrong line.
    ...(typeof line === 'number'
      ? { line }
      : {}),
    source: typeof source === 'string'
      ? source
      : specPath,
  };
}

function toResult(findings: LintFinding[]): LintResult {
  const errors = findings.filter((finding) => finding.severity === 'error');
  return { ok: errors.length === 0, errors, findings };
}

/**
 * Lints one OpenAPI document against the house ruleset.
 *
 * Returns `ok: false` when the document violates a rule at error severity or
 * does not parse. Throws when the gate itself could not run — a missing
 * binary, a missing or malformed ruleset, or output vacuum was not expected
 * to produce.
 */
export async function lintSpec(specPath: string, options: LintOptions = {}): Promise<LintResult> {
  const rulesetPath = options.rulesetPath ?? HOUSE_RULESET_PATH;
  const bin = options.vacuumBin ?? process.env['VACUUM_BIN'] ?? 'vacuum';

  // Both paths are checked here rather than left to vacuum, which reports
  // every one of these as the same exit 2 and distinguishes them only by
  // message wording. Branching on wording would break on a vacuum upgrade.
  if (!existsSync(rulesetPath)) {
    throw new Error(`lint gate cannot run: ruleset not found at '${rulesetPath}'`);
  }
  if (!existsSync(specPath)) {
    throw new Error(`lint gate cannot run: spec not found at '${specPath}'`);
  }

  const run = await runVacuum(bin, ['spectral-report', '-r', rulesetPath, '-o', specPath]);

  if (run.code === 2) {
    const text = failureText(run);
    // vacuum names the offending file in both cases. When the document under
    // test is the one it names, that is a fact about the document and belongs
    // in the report; anything else is the gate failing to run.
    if (!text.includes(specPath)) {
      throw new Error(`lint gate cannot run: ${text}`);
    }
    return toResult([{
      code: SPEC_PARSE_FAILED,
      path: [],
      message: text,
      severity: 'error',
      source: specPath,
    }]);
  }

  if (run.code !== 0) {
    throw new Error(`lint gate cannot run: ${bin} exited ${run.code}: ${failureText(run)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch (cause) {
    throw new Error(
      `lint gate cannot run: ${bin} exited 0 but did not emit JSON for '${specPath}'`,
      { cause },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `lint gate cannot run: ${bin} emitted ${typeof parsed}, expected an array of findings`,
    );
  }

  return toResult(parsed.map((raw) => toFinding(raw, specPath)));
}
