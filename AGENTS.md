# Repository guide

This repo is the deliverable for a technical case study (see `CASE-STUDY.md`).
It is **public**: everything committed here is read by an external reviewer.

## What is here today

| Path                        | What it is                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `tools/ralph`               | The agent task loop (`bun run ralph plan \| start \| usage`), run from the repo root.           |
| `tools/control-byte-gate`   | Byte-level scan of tracked files for control bytes and invisible codepoints. Imports nothing.   |
| `tools/unsafeUnicode.mjs`   | The `house/no-unsafe-unicode` ESLint rule the gate above is kept in sync with.                  |
| `.specs/`                   | Design input for the loop. Tracked, so the reviewer sees what the work was derived from.        |
| `.plans/`                   | Plans and trackers the loop reads. Tracked, for the same reason.                                |
| `PRESENTATION.md`           | Task 1 deliverable.                                                                              |
| `README.md`, `CASE-STUDY.md`| Problem statement and interpretation.                                                            |

No application packages exist yet. `.specs/01-bare-minimal-api-governance-poc.md`
defines the target layout (`apps/*`, `packages/*`, `services/*`) that the plan
builds out; `package.json` already declares those three workspace globs.

## Naming

- Package scope is `@marcos-corp/*`. The spec writes `@org/*` generically —
  read it as `@marcos-corp/*`.
- The spec's header says "pnpm monorepo"; this repo is **bun workspaces**.
  `packageManager` is pinned in `package.json`.

## Shared tooling

- `eslint.base.mjs` + `sharedRules.mjs` at the root; the root and each
  workspace package layer their own leaf `eslint.config.mjs` on top.
- `tsconfig.base.json` is the shared strict core; leaves specialize. The root
  `tsconfig.json` covers `tools/` and root files only.
- Root scripts: `lint:all`, `check-types:all`, `test:all` fan out to every
  workspace package; bare `lint` / `check-types` / `test` cover root files and
  `tools/`.
- Runtime is bun-first. Node 22 is also required on PATH (`engines`).

## Verification order

Run in this order; each is cheap and the earlier ones localize failures better:

```bash
bun run lint && bun run check-types && bun run test && bun run gate:control-bytes
```

`gate:control-bytes` scans **tracked** files, so a file only enters its scope
once it is committed.

## Plans and specs

- Specs live in `.specs/`, plans and trackers in `.plans/`. Both are tracked
  on purpose: the spec, the plan derived from it, and the commits closing each
  task are the provenance chain this case study is partly judged on.
- Generate: `bun run ralph plan --spec=.specs/<file>.md`
- Execute: `bun run ralph start --plan=.plans/PLAN-<stub>.md`
- Never hand-edit a `PLAN_TRACKER-*.md` — the loop owns it.

## Security posture

- This repo is public and must stay that way for review. Never wire CI to a
  self-hosted runner, and never commit anything that assumes a private host.
- `.claude/worktrees/` is gitignored: it holds live git worktrees belonging to
  a different repository. Git records embedded repos as gitlinks, so staging
  them would publish dangling entries.
