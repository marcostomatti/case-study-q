Refer to @AGENTS.md for the repository map, shared tooling, verification order,
the plans/specs workflow, and the security posture.

Quick orientation:

- Bun-workspaces monorepo, scope `@marcos-corp/*`. Workspace globs `apps/*`,
  `packages/*`, `services/*` are declared but not yet populated — the spec at
  `.specs/01-bare-minimal-api-governance-poc.md` defines what lands there.
- Ralph loop lives at `tools/ralph`; always run it from the repo root.
- `.specs/` and `.plans/` are **tracked** in this repo (unlike the repo this
  tooling was ported from) so a reviewer can follow spec → plan → commits.
- This repo is public. No self-hosted runners, no private-host assumptions.
- A package that gains its own `AGENTS.md` owns its conventions; read it before
  working inside that package.
