---
name: progress-hygiene
description: Use when finishing a loop run or queue item, when progress.txt exceeds ~8k characters, or when asked to clean up loop findings — governs what gets promoted out of progress.txt (skills, AGENTS.md, docs) and what gets deleted, so the file stays small enough to inject into plan generation.
---

# progress-hygiene — keep progress.txt small and true

`progress.txt` is the loop's scratch memory: broadly-applicable findings
appended between tasks. Since `ralph plan` injects it into plan generation
as advisory context, it earns its size — every stale or duplicated line is
context bloat for every future plan. The injection has a hard cap (16k
chars, oldest findings truncated first — see `tools/ralph/plan.ts`); this
skill exists so the file stays well under the cap and the cap never has to
act.

## When to compact

- At the end of every completed plan (the loop's finishing step does this).
- Between items in a multi-plan queue run.
- Whenever the file exceeds **~8k characters**, even mid-plan, if you are
  already editing it.

## The promotion ladder — persist first, then delete

A finding leaves `progress.txt` in one of two ways: promoted somewhere
durable, or deleted as noise. Never delete an unpromoted finding that is
still broadly true.

| Finding | Destination |
| --- | --- |
| A reusable pattern, gotcha, or technique | A skill: invoke the learn/learn-eval skill when available in the session; otherwise write `.claude/skills/<name>/SKILL.md` by hand |
| A repo convention or architectural fact | `AGENTS.md` (or the pertinent existing skill) |
| Consumer-facing behaviour | `README.md` / `docs/` |
| A defect or follow-up too big for now | A spec — `.specs/` if sensitive (unpatched privacy/security), tracked `specs/` + index otherwise |

## What to delete outright

- Findings already persisted anywhere durable (verify, then drop — the
  durable copy is now the source of truth).
- Task-specific details that never belonged (the loop prompt forbids them,
  but they leak in).
- Stale facts: anything a later finding or the current code contradicts.
- Duplicates and near-duplicates — keep the most precise phrasing.

## How to compact

Rewrite the file, don't append a "cleaned" section. Keep surviving findings
in their original order (recency is meaningful — the injection cap truncates
oldest-first). One finding per line or short bullet, no headers, no dates.
If nothing survives, leave the file empty rather than deleting it.
