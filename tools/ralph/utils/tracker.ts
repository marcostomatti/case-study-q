import fs from 'fs';

export interface TaskInfo {
  task: string;
  lineNum: number; // 0-indexed
  status: 'blocked' | 'unchecked';
}

/**
 * Finds the next task to execute in a tracker file.
 *
 * Blocked tasks are resumed first; otherwise the first unchecked task wins.
 * Only lines starting with `- [ ]` / `- [BLOCKED]` count — headings, stage
 * comments, and prose between items are ignored, so plans may carry stage
 * headings without confusing the loop.
 */
export function findNextTask(trackerContent: string): TaskInfo | null {
  const lines = trackerContent.split('\n');

  // Prefer resuming a blocked task first
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/^- \[BLOCKED\] (.+)/);
    if (match?.[1]) return { task: match[1].trim(), lineNum: i, status: 'blocked' };
  }

  // Otherwise find the next unchecked task
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/^- \[ \] (.+)/);
    if (match?.[1]) return { task: match[1].trim(), lineNum: i, status: 'unchecked' };
  }

  return null;
}

/** Rewrites one tracker line to the given status. */
export function updateTrackerLine(
  trackerPath: string,
  lineNum: number,
  newStatus: 'done' | 'blocked',
): void {
  const lines = fs.readFileSync(trackerPath, 'utf8').split('\n');
  const line = lines[lineNum];
  if (!line) return;

  if (newStatus === 'done') {
    lines[lineNum] = line.replace(/^- \[ \]/, '- [x]').replace(/^- \[BLOCKED\]/, '- [x]');
  } else {
    lines[lineNum] = line.replace(/^- \[ \]/, '- [BLOCKED]');
    // Already [BLOCKED]? No change needed.
  }
  fs.writeFileSync(trackerPath, lines.join('\n'), 'utf8');
}

/**
 * Derives the tracker path for a plan file: `PLAN.md` → `PLAN_TRACKER.md`,
 * `PLAN-foo.md` → `PLAN_TRACKER-foo.md`. Keeping one tracker per plan lets
 * several plans coexist without clobbering each other's progress.
 */
export function trackerPathFor(planPath: string): string {
  return planPath.replace(/PLAN(-[^/]*)?\.md$/, (_m, stub: string | undefined) => `PLAN_TRACKER${stub ?? ''}.md`);
}
