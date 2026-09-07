# Plan-generation instructions

Create a plan based on the spec provided below, following the plan document
format in `.claude/skills/dev-planner/SKILL.md` exactly. Produce the required
checklists, technical assessments, feature requirements and acceptance
criteria — **do not execute the plan**.

{PROGRESS_SECTION}

## Files to produce

* Store the plan in `{PLAN_FILE}` (the `.plans/` directory is untracked on
  purpose — plans may describe unpatched issues; never move them into a
  tracked path).
* If the plan assumes any prerequisite — a service running, a credential in an
  env var, an installed tool — create `{PREREQUISITES_FILE}` with those steps
  as a human checklist (see the PREREQUISITES.md format in the dev-planner
  skill). Only genuinely non-automatable steps; do not duplicate what
  `README.md`/`AGENTS.md` already require of every contributor. Link to it
  from the plan.
* Do not create or touch any tracker file — the loop derives it from the plan.

## Plan format (parser contract)

* Every task is a flat `- [ ]` checklist line. The loop's parser only reads
  lines starting with `- [ ]` / `- [BLOCKED]` — anything else (headings,
  prose, code blocks) is invisible to it, so never encode a task any other
  way, and never nest tasks.
* Group tasks under `# Stage: {name}` headings (top-level `#`). Stage
  headings are visual separators only; the checklist must read as one flat
  sequence across stages.
* One atomic action per task; no compound tasks joined by "and". Tasks must
  be independently completable in the order listed. A module-sized
  deliverable (see Task sizing below) counts as one atomic action.
* Use imperative, specific wording ("Add Zod schema for `CreateJobRequest`",
  not "Handle input validation").
* Avoid the words "current", "previous" and "next" in task text — the loop
  injects task text into agent prompts, and relative references confuse the
  agent about what is already done.
* Keep the plan focused on tasks and technical context only — no behavioral
  instructions, opinions, or questions for follow-up. Link to relevant
  `.claude/skills/` files where they clarify a task.
* Add a test task at the end of each stage at minimum; for larger stages,
  test in smaller increments. Negative tests before positive tests; unit
  tests before integration tests; test tasks live in the stage they cover.
  Stage-end test tasks cover cross-module/integration behavior — a module's
  own unit tests ride inside its module task (Task sizing below).

## Task sizing (session economics)

* One task = one full agent session, so task COUNT is the plan's
  wall-clock. Target **≤80 tasks**; exceed it only when the spec genuinely
  enumerates more independent deliverables, and say so in the Description.
* A module ships as ONE task: implementation + its TSDoc + its colocated
  unit tests together. Never split creation from documentation, or from
  the tests that cover only that module.
* Documentation-only updates fold into the task whose change they document
  (the same-commit doc law already requires the pairing).
* Keep as SEPARATE tasks: cross-cutting verification (fan-out gates,
  invariant sweeps), live-seam runs, migrations, and close-out — these
  preserve resumability where a halt is most likely.
* The RUNNER owns the push and the pull request. After the last task it
  runs a wrap-up session that promotes findings, compacts `progress.txt`,
  commits, pushes and opens (or updates) the PR — so a plan must NOT
  carry a task that opens one. Two openers race: measured, one run cut a
  second branch and opened a second PR for a single plan. A close-out
  task SHOULD still take the mergeability reading
  (`git merge-tree --write-tree origin/main HEAD`) and assemble the body
  material — the gate captures, the test plan, the recorded debt — into
  the plan's close-out notes for that wrap-up session to use.

## Spec

{SPEC_CONTENT}
