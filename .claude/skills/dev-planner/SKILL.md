---
name: dev-planner
description: Use when producing or parsing a plan document (PLAN-<stub>.md, PLAN_TRACKER-<stub>.md, PREREQUISITES-<stub>.md) for the ralph agent loop — establishes the checkbox/stage-heading syntax the tracker parser requires, task granularity rules, and testing-task insertion patterns.
---

# dev-planner — Plan Document Format Specification

This skill specifies the format of plan documents produced for feature development work and consumed by the ralph agent loop (`tools/ralph/`). It does not define agent behavior, personas, or workflow — those belong in agent profiles.

---

## Files produced by a planning session

| File | Purpose |
| --- | --- |
| `PLAN-<stub>.md` | Full task checklist with technical context, stage labels, and code examples |
| `PLAN_TRACKER-<stub>.md` | Loop-parsed checklist; must use the exact format the parser expects |
| `PREREQUISITES-<stub>.md` | Non-automatable setup steps required before the plan can run (only when any exist) |

Plans are generated with `bun run ralph plan --spec=specs/<file>.md` (optionally `--stub=<name>`; the stub defaults to the spec's basename) and live at the repo root. The tracker is derived from the plan file by `trackerPathFor()` in `tools/ralph/utils/tracker.ts` (`PLAN-foo.md` → `PLAN_TRACKER-foo.md`) — never create or edit the tracker by hand during planning; the loop owns it. The unstubbed forms `PLAN.md` / `PLAN_TRACKER.md` / `PREREQUISITES.md` are also valid and are the loop's default (`bun run ralph start` with no `--plan`).

Execute a plan with `bun run ralph start --plan=PLAN-<stub>.md`.

---

## PLAN.md format

`PLAN-<stub>.md` is the human-readable plan. Its task lines are injected directly into agent prompts by the loop.

```markdown
# Plan: {Feature Title}

## Description

{Technical context and background. No behavioral instructions.}

# Stage: {Stage Name}
- [ ] Task one
- [ ] Task two

# Stage: {Next Stage}
- [ ] Task three
```

Rules:
- Stage labels use `# Stage: {name}` (top-level heading, not `##`).
- Tasks use `- [ ]` checkbox syntax.
- Keep the plan focused on tasks and technical context only. Link to relevant `.claude/skills/` files where they clarify a task, but do not embed behavioral prose.
- Code snippets are allowed to illustrate a desired pattern. Keep them minimal and directly relevant to the task.
- Do not use words like "current", "previous", or "next" in task descriptions. The loop injects the task text directly into agent prompts; relative references confuse the agent about what has already been done.
- If the plan is long, add a `PLAN_SUMMARY-<stub>.md` with a high-level overview of stages for quick reference.

### Plan header: `Implements`

A plan that implements a GitHub issue opens with, near the top of the Description:

```markdown
**Implements:** #<n>
```

so the work stays traceable back to the issue it delivers.

---

## PLAN_TRACKER.md format

`PLAN_TRACKER-<stub>.md` is consumed line-by-line by `findNextTask()` in `tools/ralph/utils/tracker.ts`. The parser applies strict prefix matching — any deviation in syntax will cause tasks to be skipped or misread.

```markdown
# Stage: {Stage Name}

- [ ] Open task — not yet started
- [x] Completed task
- [BLOCKED] Blocked task — {reason why it is blocked}
```

### Parser format contract

| Status | Exact line prefix | Parser regex |
| --- | --- | --- |
| Unchecked | `- [ ] ` | `^- \[ \] (.+)` |
| Completed | `- [x] ` | written by the loop's `updateTrackerLine()`; skipped by the parser |
| Blocked | `- [BLOCKED] ` | `^- \[BLOCKED\] (.+)` |

Important notes:
- `[BLOCKED]` uses uppercase only. `[blocked]` or `[Blocked]` will not be matched.
- There is one space between `]` and the task text for both `- [ ]` and `- [BLOCKED]`.
- Stage heading lines (`# Stage: ...`) are **not parsed** by the loop. They are visual separators only and do not affect task selection — as is any other prose or code between task lines.
- `findNextTask()` prefers blocked tasks over unchecked ones — it resumes interrupted work before starting new tasks.

---

## PREREQUISITES.md format

`PREREQUISITES-<stub>.md` lists non-automatable setup steps. It is not parsed by the loop — it is a human checklist.

```markdown
# Prerequisites

## Services
- [ ] {Service name} running on port {n}

## Environment Variables
- `VAR_NAME` — description and where to obtain it

## Credentials
- [ ] {Credential description}
```

Rules:
- Only include prerequisites that are genuinely non-automatable (installed services, external credentials, manual env var setup).
- Do not duplicate steps already documented in the repo's contributor docs (README, CONTRIBUTING, and the like).
- For example: do not mark `bun install` as a prerequisite if it is already documented as a required step for all development work.
- Link to the prerequisites file from the plan.

---

## Task granularity guidelines

- One atomic action per task. Each task must be completable in a single focused session without depending on another task being partially done.
- No compound tasks joined by "and". Split "implement X and write tests for X" into two tasks.
- Tasks must be independently completable in the order listed.
- Use imperative, specific wording: "Add Zod schema for `CreateJobRequest`" rather than "Handle input validation".

---

## Testing task insertion patterns

- Add a test task at the end of each stage at minimum.
- For large refactors or multi-file additions, add test tasks at smaller increments — logical sub-chunks that can be verified independently.
- Write negative tests before positive tests (error paths, early exits, edge cases).
- Write unit tests before integration tests.
- Place test tasks in the same stage as the code they cover, not in a separate testing stage.

---

## `[BLOCKED]` marker

The `[BLOCKED]` marker is written by the loop (via `updateTrackerLine()`) when a task fails or is interrupted. Format:

```text
- [BLOCKED] {task description} — {reason why it is blocked}
```

- The em dash (`—`) separates the task description from the reason. Do not use a hyphen (`-`) or colon.
- The full line including reason is passed back to the agent as the scoped task on the next run.
- Do not reformat `[BLOCKED]` lines manually unless correcting a syntax error — the loop will re-parse them on the next iteration.

---

## Format validation

Before changing checkbox syntax or stage heading format, verify compatibility against `findNextTask()` and `updateTrackerLine()` in `tools/ralph/utils/tracker.ts`. The parser uses simple prefix regex matching with no tolerance for whitespace variations or casing differences.
