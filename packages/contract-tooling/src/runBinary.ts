/**
 * The one place this package starts an external gate binary.
 *
 * Two of the four blocking gates in spec section 8 shell out to a static Go
 * binary that is a documented prerequisite rather than a dependency: `vacuum`
 * for the house-rule lint and `oasdiff` for the breaking-change diff. Both
 * need the same three things, and getting any of them wrong produces a gate
 * that silently never fails:
 *
 *   - both streams captured in full, because the machine-readable payload and
 *     the human-readable failure text arrive on different ones;
 *   - every exit code returned to the caller rather than thrown on, because
 *     neither binary uses exit status to mean "found something" by default;
 *   - a binary that is not installed reported as "this gate could not run",
 *     never as "this gate found nothing".
 *
 * That last one is the reason this is a module and not a lambda: an ENOENT
 * swallowed into an empty result set is indistinguishable from a clean spec,
 * and it is the failure an unprovisioned CI runner actually produces.
 */
import { spawn } from 'node:child_process';

export interface BinaryRun {
  /** The process exit code, or -1 when the process was signalled. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunBinaryOptions {
  /** Names the gate in the thrown message, e.g. `lint` or `diff`. */
  gate: string;
  /** The environment variable that overrides the binary, e.g. `OASDIFF_BIN`. */
  envVar: string;
}

/**
 * Runs a gate binary and collects both streams.
 *
 * Resolves for any exit code — the caller decides which ones mean what — and
 * rejects only when the process could not be started at all.
 */
export function runBinary(
  bin: string,
  args: readonly string[],
  options: RunBinaryOptions,
): Promise<BinaryRun> {
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
          `${options.gate} gate cannot run: could not execute '${bin}'. It is a documented `
          + 'prerequisite (see .plans/PREREQUISITES-01-bare-minimal-api-governance-poc.md); '
          + `install it on PATH, or point $${options.envVar} at it.`,
          { cause },
        ));
        return;
      }
      reject(cause);
    });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });

    // Neither binary reads stdin the way this package invokes it, but a pipe
    // left open is a way to hang on a future version that probes it.
    child.stdin.end();
  });
}
