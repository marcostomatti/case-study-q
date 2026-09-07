/**
 * Tests for the ralph start loop (scripts/ralph/start.ts).
 *
 * Mocks:
 *  - 'fs'                     — no real disk I/O
 *  - './utils/claude.js'      — no real Claude subprocess
 *  - './utils/git.js'         — no real git invocations
 *  - './utils/tracker.js'     — tracker helpers (findNextTask, updateTrackerLine)
 *
 * findNextTask is tested as a pure function without mocking.
 */

import { describe, expect, it } from 'vitest';

// ── Pure unit tests for tracker helpers ──────────────────────────────────────
 
import { findNextTask } from '../utils/tracker.js';

describe('findNextTask', () => {
  it('returns null when tracker has no tasks', () => {
    expect(findNextTask('# Plan\n\nSome text\n')).toBeNull();
  });

  it('returns the first unchecked task', () => {
    const content = '# Plan\n- [x] Done\n- [ ] Task A\n- [ ] Task B\n';
    const result = findNextTask(content);
    expect(result).toMatchObject({ task: 'Task A', status: 'unchecked', lineNum: 2 });
  });

  it('prefers a BLOCKED task over an unchecked one', () => {
    const content = '# Plan\n- [ ] Task A\n- [BLOCKED] Task B\n';
    const result = findNextTask(content);
    expect(result).toMatchObject({ task: 'Task B', status: 'blocked', lineNum: 2 });
  });

  it('returns the first BLOCKED task when multiple exist', () => {
    const content = '- [BLOCKED] First blocked\n- [BLOCKED] Second blocked\n- [ ] Unchecked\n';
    const result = findNextTask(content);
    expect(result).toMatchObject({ task: 'First blocked', lineNum: 0 });
  });

  it('returns null when all tasks are completed', () => {
    const content = '- [x] Done A\n- [x] Done B\n';
    expect(findNextTask(content)).toBeNull();
  });

  it('trims whitespace from task names', () => {
    const content = '- [ ]   Padded task   \n';
    expect(findNextTask(content)?.task).toBe('Padded task');
  });
});
