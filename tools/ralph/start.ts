#!/usr/bin/env bun

/**
 * ralph start — the task loop.
 *
 * Walks the plan's tracker checklist one task at a time, delegating each task
 * to a Claude Code session, marking `[x]` on success and `[BLOCKED]` on
 * failure or interrupt. Re-running resumes: blocked tasks are retried first.
 *
 *   bun tools/ralph/ralph.ts start [--plan=PLAN-foo.md] [--start-at=HH:MM]
 *
 * --plan     plan file to execute (default: PLAN.md at the repo root). The
 *            tracker is derived per plan (PLAN-foo.md → PLAN_TRACKER-foo.md)
 *            so several plans can coexist.
 * --start-at defer the run until a local time of day (e.g. 23:00) — queue
 *            off-hours runs without cron.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { runClaude, checkUsage } from './utils/claude.js';
import { getCurrentBranch, getRepoRoot } from './utils/git.js';
import { deferUntil } from './utils/schedule.js';
import { findNextTask, trackerPathFor, updateTrackerLine } from './utils/tracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let interrupted = false;

async function preserveProgress(): Promise<void> {
  const branch = getCurrentBranch();

  const prompt = [
    '* Read `@progress.txt` in full.',
    '* If there\'s anything worth keeping, grab what\'s generally relevant from `@progress.txt` and include it in `@AGENTS.md`, `@README.md`, `@CONTRIBUTING.md` or a pertinent skill under `.claude/skills/`.',
    '* If a learn/learn-eval skill is available in this session, invoke it now so reusable patterns from this run are persisted as skills.',
    '* Then compact `@progress.txt` per `.claude/skills/progress-hygiene/SKILL.md`: drop every finding that was just persisted somewhere durable and anything stale or task-specific; keep only broadly-relevant findings not yet promoted. The file must stay small — future plan generation injects it as context.',
    '* If it\'s present, extract the issue reference from the plan file (e.g. "#42") to be used in the PR title.',
    `* If the reference is not present on the plan check if the branch name (${branch}) carries one (e.g. feat/42-slug).`,
    '* Use the plan title as the PR title, include the issue reference if you found it, e.g. "Implement user authentication (#42)".',
    '* Create a concise yet descriptive PR description that summarizes the overall work done based on the completed plan and progress notes.',
    `* Commit these changes and push them to the CURRENT branch (${branch}). Never create a branch here: the work under review is this branch's, and a second branch splits one plan across two reviews.`,
    '* This step is IDEMPOTENT because a plan\'s own close-out may already have opened the PR. Read the state first with `gh pr list --head <branch> --state open --json number`: when it names a PR, push to it and update its body with `gh pr edit` so the description covers the promotions this session just committed; only create one with `gh pr create` when that list is empty. A `gh pr create` failure saying the PR already exists is the expected shape of that race, never a reason to open a second PR from a new branch.',
    '* Do not include Claude attribution in the commit or PR message.',
  ].join('\n');

  const exitCode = await runClaude(prompt);
  if (exitCode !== 0) {
    console.error(`\n❌ Failed to preserve progress (exit ${exitCode}). Please try again.`);
  } else {
    console.log('\n✅ Progress preserved; PR opened or updated on this branch.');
  }
}

function argValue(args: string[], flag: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit?.slice(flag.length + 1);
}

export default async function start(args: string[]): Promise<void> {
  const repoRoot = getRepoRoot();

  const startAt = argValue(args, '--start-at');
  if (startAt) await deferUntil(startAt);

  // Default plan: .plans/PLAN.md (the untracked plans directory `ralph plan`
  // writes to), falling back to a root PLAN.md for hand-written plans.
  const planArg = argValue(args, '--plan');
  const defaultPlanPath = fs.existsSync(path.join(repoRoot, '.plans', 'PLAN.md'))
    ? path.join(repoRoot, '.plans', 'PLAN.md')
    : path.join(repoRoot, 'PLAN.md');
  const planPath = planArg
    ? path.resolve(repoRoot, planArg)
    : defaultPlanPath;

  const rootPromptPath = path.join(repoRoot, 'PROMPT.md');
  const promptPath = fs.existsSync(rootPromptPath)
    ? rootPromptPath
    : path.join(__dirname, 'PROMPT.md');

  const trackerPath = trackerPathFor(planPath);

  if (!fs.existsSync(planPath)) {
    console.error(`❌ Plan file not found: ${planPath}`);
    process.exit(1);
  }

  const planContent = fs.readFileSync(planPath, 'utf8');
  const promptContent = fs.readFileSync(promptPath, 'utf8');

  // Initialize tracker only if it doesn't exist
  if (!fs.existsSync(trackerPath)) {
    console.log(`📋 Creating new plan tracker at ${path.basename(trackerPath)}...`);
    fs.copyFileSync(planPath, trackerPath);
  } else {
    console.log(`📋 Resuming from existing ${path.basename(trackerPath)}...`);
  }

  // SIGINT: flag and finish cleanup (mark blocked + exit) after the await returns.
  process.on('SIGINT', () => {
    interrupted = true;
  });

  while (true) {
    if (interrupted) break;

    const trackerContent = fs.readFileSync(trackerPath, 'utf8');
    const taskInfo = findNextTask(trackerContent);

    if (!taskInfo) {
      console.log('\n✅ All tasks completed!');
      console.log('🧹 Wrap-up session starting: promote progress.txt findings, compact it, then commit, push and open the PR.');
      console.log('   This is one full Claude session with no intermediate output — expect several quiet minutes. Interrupting it skips the push and PR; if that happens, run again to retry just this stage.');
      await preserveProgress();
      break;
    }

    if (taskInfo.status === 'blocked') {
      console.log(`\n⚠️  Resuming blocked task: ${taskInfo.task}`);
    } else {
      console.log(`\n🔄 Executing task: ${taskInfo.task}`);
    }

    const prompt = [
      `Your scoped task is: ${taskInfo.task}`,
      'Consider tasks listed above this one in the plan checklist as completed. Do not re-evaluate or re-do them. Focus only on the scoped task.',
      '',
      promptContent,
      planContent,
    ].join('\n');

    const exitCode = await runClaude(prompt);

    if (interrupted) {
      updateTrackerLine(trackerPath, taskInfo.lineNum, 'blocked');
      console.log('\n⚠️  Interrupted. Task marked as blocked. Run again to resume.');
      process.exit(0);
    }

    if (exitCode !== 0) {
      updateTrackerLine(trackerPath, taskInfo.lineNum, 'blocked');
      console.error(`\n❌ Task failed (exit ${exitCode}). Marked as blocked. Run again to retry.`);
      return;
    }

    updateTrackerLine(trackerPath, taskInfo.lineNum, 'done');
    console.log(`✅ Task done: ${taskInfo.task}`);

    const shouldPause = await checkUsage('task');
    if (shouldPause) {
      console.log('\n⚠️  Pausing task loop due to high Claude usage. Run again when usage is lower.');
      break;
    }
  }
}
