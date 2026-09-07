/**
 * Tests for the merged loop's new pieces: per-plan tracker derivation,
 * --start-at time math, and plan-prompt templating.
 */
import { describe, expect, it } from 'vitest';

import { buildPlanPrompt, formatProgressSection, stubFromSpecPath } from '../plan.js';
import { msUntil } from '../utils/schedule.js';
import { trackerPathFor } from '../utils/tracker.js';

describe('trackerPathFor', () => {
  it('maps the default plan to the default tracker', () => {
    expect(trackerPathFor('/repo/PLAN.md')).toBe('/repo/PLAN_TRACKER.md');
  });

  it('keeps the stub suffix so plans get independent trackers', () => {
    expect(trackerPathFor('/repo/PLAN-auth-basic.md')).toBe('/repo/PLAN_TRACKER-auth-basic.md');
  });
});

describe('msUntil', () => {
  it('computes the delay to a later time today', () => {
    const now = new Date('2026-08-19T10:00:00');
    expect(msUntil('10:30', now)).toBe(30 * 60_000);
  });

  it('rolls to tomorrow when the time already passed', () => {
    const now = new Date('2026-08-19T23:30:00');
    expect(msUntil('23:00', now)).toBe(23.5 * 60 * 60_000);
  });

  it('rejects malformed input', () => {
    expect(() => msUntil('9pm')).toThrow(/HH:MM/);
    expect(() => msUntil('25:00')).toThrow(/valid time/);
  });
});

describe('buildPlanPrompt', () => {
  const template = 'plan={PLAN_FILE} prereq={PREREQUISITES_FILE}\n{PROGRESS_SECTION}\n---\n{SPEC_CONTENT}';

  it('substitutes plan, prerequisites, and spec placeholders into .plans/', () => {
    const out = buildPlanPrompt(template, '# My spec', 'my-feature');
    expect(out).toContain('plan=.plans/PLAN-my-feature.md');
    expect(out).toContain('prereq=.plans/PREREQUISITES-my-feature.md');
    expect(out).toContain('# My spec');
    expect(out).not.toContain('{SPEC_CONTENT}');
    expect(out).not.toContain('{PROGRESS_SECTION}');
  });

  it('injects progress findings as advisory context when provided', () => {
    const out = buildPlanPrompt(template, '# My spec', 'my-feature', 'auth logic lives in src/auth');
    expect(out).toContain('Findings from previous runs');
    expect(out).toContain('auth logic lives in src/auth');
    expect(out).toContain('ADVISORY');
  });

  it('omits the progress section entirely when there is nothing to inject', () => {
    for (const progress of [undefined, '', '  \n ']) {
      const out = buildPlanPrompt(template, '# My spec', 'my-feature', progress);
      expect(out).not.toContain('Findings from previous runs');
    }
  });
});

describe('formatProgressSection', () => {
  it('caps oversized progress files, keeping the most recent findings', () => {
    const old = 'OLD-FINDING '.repeat(2_000);
    const recent = 'RECENT-FINDING';
    const out = formatProgressSection(old + recent);
    expect(out).toContain('older findings truncated');
    expect(out).toContain(recent);
    expect(out.length).toBeLessThan(17_500);
  });
});

describe('stubFromSpecPath', () => {
  it('derives the stub from the spec basename', () => {
    expect(stubFromSpecPath('/repo/specs/auth-basic-strategy.md')).toBe('auth-basic-strategy');
  });
});
