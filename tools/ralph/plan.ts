#!/usr/bin/env bun

/**
 * ralph plan — generate a plan (and prerequisites) from a spec.
 *
 *   bun tools/ralph/ralph.ts plan --spec=specs/my-feature.md [--stub=my-feature]
 *
 * Reads the spec, wraps it in the plan-generation instructions
 * (plan-prompt.md — the dev-planner format contract), and hands it to a
 * Claude Code session that writes:
 *
 *   PLAN-<stub>.md            the flat checklist + technical context
 *   PREREQUISITES-<stub>.md   non-automatable setup steps (only if any)
 *
 * The stub defaults to the spec's basename. Execute the result with:
 *
 *   bun tools/ralph/ralph.ts start --plan=PLAN-<stub>.md
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { checkUsage, runClaude } from './utils/claude.js';
import { getRepoRoot } from './utils/git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function argValue(args: string[], flag: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit?.slice(flag.length + 1);
}

/**
 * Keeps the injected progress notes bounded: progress.txt is curated by the
 * loop prompt (broad findings only, deduped), but it accrues across plans —
 * beyond the cap only the most recent findings are kept.
 */
const PROGRESS_CAP_CHARS = 16_000;

/** Formats the optional progress section for the plan prompt. Exported for tests. */
export function formatProgressSection(progressContent: string | undefined): string {
  const trimmed = progressContent?.trim();
  if (!trimmed) return '';

  const capped = trimmed.length > PROGRESS_CAP_CHARS
    ? `…(older findings truncated)…\n${trimmed.slice(-PROGRESS_CAP_CHARS)}`
    : trimmed;

  return [
    '## Findings from previous runs (progress.txt)',
    '',
    'Curated notes earlier loop runs left behind: patterns this codebase uses,',
    'gotchas hit, useful module locations. Treat them as ADVISORY context for',
    'better task ordering and to avoid re-discovering known traps — they are',
    'not requirements, they may be stale, and they must NOT be copied into',
    'the plan.',
    '',
    capped,
    '',
  ].join('\n');
}

/** Builds the full plan-generation prompt. Exported for tests. */
export function buildPlanPrompt(
  template: string,
  specContent: string,
  stub: string,
  progressContent?: string,
): string {
  return template
    .replaceAll('{PLAN_FILE}', `.plans/PLAN-${stub}.md`)
    .replaceAll('{PREREQUISITES_FILE}', `.plans/PREREQUISITES-${stub}.md`)
    .replaceAll('{PROGRESS_SECTION}', formatProgressSection(progressContent))
    .replaceAll('{SPEC_CONTENT}', specContent);
}

/** Derives the plan stub from a spec path: specs/my-feature.md → my-feature. */
export function stubFromSpecPath(specPath: string): string {
  return path.basename(specPath).replace(/\.md$/, '');
}

export default async function plan(args: string[]): Promise<void> {
  const repoRoot = getRepoRoot();

  const specArg = argValue(args, '--spec');
  if (!specArg) {
    console.error('Usage: ralph plan --spec=<spec-file>.md [--stub=<name>] [--no-progress]');
    console.error('Specs live in specs/ (trackable follow-ups) or .specs/ (untracked, sensitive).');
    process.exit(1);
  }

  const specPath = path.resolve(repoRoot, specArg);
  if (!fs.existsSync(specPath)) {
    console.error(`❌ Spec file not found: ${specPath}`);
    process.exit(1);
  }

  const stub = argValue(args, '--stub') ?? stubFromSpecPath(specPath);
  const plansDir = path.join(repoRoot, '.plans');
  const planPath = path.join(plansDir, `PLAN-${stub}.md`);
  if (fs.existsSync(planPath)) {
    console.error(`❌ .plans/${path.basename(planPath)} already exists — remove it or pass a different --stub.`);
    process.exit(1);
  }
  fs.mkdirSync(plansDir, { recursive: true });

  await checkUsage('issue');

  // Feed the loop's accumulated findings into planning (opt out with
  // --no-progress): the planner never used to see progress.txt, which meant
  // every plan re-discovered known gotchas and module locations.
  const progressPath = path.join(repoRoot, 'progress.txt');
  const progressContent = !args.includes('--no-progress') && fs.existsSync(progressPath)
    ? fs.readFileSync(progressPath, 'utf8')
    : undefined;
  if (progressContent?.trim()) {
    console.log('📎 Including findings from progress.txt (disable with --no-progress).');
  }

  const template = fs.readFileSync(path.join(__dirname, 'plan-prompt.md'), 'utf8');
  const specContent = fs.readFileSync(specPath, 'utf8');
  const prompt = buildPlanPrompt(template, specContent, stub, progressContent);

  console.log(`📝 Generating .plans/PLAN-${stub}.md from ${path.basename(specPath)}...`);
  const exitCode = await runClaude(prompt);

  if (exitCode !== 0) {
    console.error(`\n❌ Plan generation failed (exit ${exitCode}).`);
    process.exit(exitCode);
  }

  if (!fs.existsSync(planPath)) {
    console.error(`\n❌ The session finished but .plans/${path.basename(planPath)} was not created — inspect the output above.`);
    process.exit(1);
  }

  console.log(`\n✅ Plan ready: .plans/${path.basename(planPath)}`);
  const prereqPath = path.join(plansDir, `PREREQUISITES-${stub}.md`);
  if (fs.existsSync(prereqPath)) {
    console.log(`⚠️  Prerequisites detected: complete .plans/${path.basename(prereqPath)} before starting the loop.`);
  }
  console.log(`▶ Execute with: bun tools/ralph/ralph.ts start --plan=.plans/PLAN-${stub}.md`);
}
