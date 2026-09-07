/**
 * Claude process execution and usage utilities.
 *
 * getClaudeUsagePercent returns current API consumption as 0–100, or null if
 * unavailable. Override via CLAUDE_USAGE_PERCENT env var for testing or manual
 * control. A real data source (Anthropic billing API, CLI flag, or injected
 * env var) should be wired in once reliably identified.
 */

export async function getClaudeUsagePercent(): Promise<number | null> {
  const envPct = process.env['CLAUDE_USAGE_PERCENT'];
  if (envPct !== undefined) {
    const pct = Number(envPct);
    return Number.isFinite(pct)
      ? Math.max(0, Math.min(100, pct))
      : null;
  }
  return null;
}

/**
 * Checks current Claude usage and warns / signals a pause.
 *
 * context 'issue' — called before starting a new issue. Warns at ≥70%.
 * context 'task'  — called between ralph tasks. Warns at ≥80%, returns true
 *                   (pause signal) at ≥90%.
 *
 * Returns true if the caller should stop its current loop iteration.
 */
export async function checkUsage(context: 'issue' | 'task'): Promise<boolean> {
  const pct = await getClaudeUsagePercent();
  if (pct === null) return false;

  if (context === 'task' && pct >= 90) {
    console.warn(
      `\nClaude usage at ${pct.toFixed(0)}% (>=90%). Pausing after current task to avoid hitting the limit.`,
    );
    return true;
  }
  if (pct >= 80) {
    console.warn(
      `\nClaude usage at ${pct.toFixed(0)}% (>=80%). Monitor closely — tasks may be interrupted.`,
    );
  } else if (context === 'issue' && pct >= 70) {
    console.warn(
      `\nClaude usage at ${pct.toFixed(0)}% (>=70%). Consider whether to start the next issue.`,
    );
  } else {
    console.info(`\nClaude usage: ${pct.toFixed(0)}%`);
  }
  return false;
}

export async function runClaude(prompt: string): Promise<number> {
  const proc = Bun.spawn(['claude', '-p', '--dangerously-skip-permissions'], {
    stdin: new TextEncoder().encode(prompt),
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      // Allow ECC continuous-learning hooks to observe ralph sessions.
      // observe.sh Layer 1 filters on CLAUDE_CODE_ENTRYPOINT — 'cli' is
      // in the allow-list; the default for -p mode is not.
      CLAUDE_CODE_ENTRYPOINT: 'cli',
    },
  });
  return (await proc.exited) ?? 1;
}
