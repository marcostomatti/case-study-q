# Repository guide

This repo is the deliverable for a technical case study (see `CASE-STUDY.md`).
It is **public**: everything committed here is read by an external reviewer.

What it demonstrates is API contract *governance* — consumers author contract
proposals, providers approve and own them, and a mock derived from the contract
unblocks the consumer at merge rather than at deploy. Design input is
`.specs/01-bare-minimal-api-governance-poc.md`; the tier-to-gate mapping is
`docs/governance.md`.

## Workspace map

| Path | Package | What it is |
| --- | --- | --- |
| `packages/contracts-service-a` | `@marcos-corp/contracts-service-a` | The published contract: TypeBox schemas, a ts-rest contract, an emitted OpenAPI artifact. Owned by team A via CODEOWNERS. Must not import `@marcos-corp/db`. |
| `packages/contracts-service-b` | `@marcos-corp/contracts-service-b` | Same, for invoices. Owned by team B. |
| `packages/db` | `@marcos-corp/db` | Drizzle schema and migrations. Explicitly not a dependency of any contract package. |
| `packages/contract-tooling` | `@marcos-corp/contract-tooling` | The gates: `emitOpenApi`, `lintSpec`, `diffSpecs`, `assertNoDbImport`, `assertExactContractPins`, and `runGates` composing the first four. |
| `services/service-a` | `@marcos-corp/service-a` | The provider. `routes` -> `mapping` -> `repositories`, with client identity and usage logging as middleware. |
| `services/service-b` | `@marcos-corp/service-b` | A provider that is also a consumer of `contracts-service-a`. |
| `apps/web-a` | `@marcos-corp/web-a` | Same-team consumer. Deliberately thin. |
| `apps/web-b` | `@marcos-corp/web-b` | Cross-team consumer; carries the spec §2.5 tolerance obligations. |
| `tools/ralph` | — | The agent task loop (`bun run ralph plan \| start \| usage`), run from the repo root. |
| `tools/control-byte-gate` | — | Byte-level scan of tracked files. Imports nothing, so it runs on a bare checkout. |
| `scripts/` | — | `pipeline-simulation.ts` (the spec §8 gates), `demo.ts`, and `acceptance/` (the spec §9 criteria). |

## Naming and conventions

- Package scope is `@marcos-corp/*`. The spec writes `@org/*` generically.
- **bun workspaces**, not pnpm. See `.claude/skills/bun-workspace-traps/SKILL.md`
  before adding a package — the leaf gate scopes are not what they look like.
- Contract packages author schemas in **TypeBox** behind **ts-rest**. Zod is the
  tool for everything internal to a service — env parsing, post-parse coercion,
  repository shapes — and never crosses into a contract package.
- Money is an integer minor-unit value plus an ISO-4217 code. Never a float,
  never preformatted.
- `null` is never emitted; absent means not applicable. The linter enforces it.

## Verification order

```bash
bun run lint:all && bun run check-types:all && bun run test:all && bun run gate:control-bytes
bun run pipeline:simulate
```

Two things about this that cost a red run each time they are rediscovered:

- **`bun run lint` and `bun run lint:all` are different gates.** The root config
  ignores the workspace globs, so leaf files are linted only through the
  fan-out. Root exiting 0 while the fan-out fails is normal.
- **`gate:control-bytes` scans tracked files only.** A file enters its scope
  when it is committed, not when it is written.

`test:all` requires `vacuum`, `oasdiff` and a Postgres. See
`.plans/PREREQUISITES-01-bare-minimal-api-governance-poc.md`.

## Running it

```bash
bun run demo:up   # Postgres + a Prism mock over the contract + service-a
```

Ports are 55432 / 53000 / 54010, deliberately not the defaults — a local
Postgres on 5432 is what this stack first collided with. Walkthrough is
`docs/demo-script.md`; teardown is
`docker compose -f docker/compose.yaml down -v`.

## Plans and specs

- Specs in `.specs/`, plans and trackers in `.plans/`. Both **tracked** on
  purpose: spec, plan and the commits closing each task are the provenance
  chain this case study is partly judged on.
- Generate: `bun run ralph plan --spec=.specs/<file>.md`
- Execute: `bun run ralph start --plan=.plans/PLAN-<stub>.md`
- Never hand-edit a `PLAN_TRACKER-*.md` while the loop owns it.

**Keep `progress.txt` small.** The loop reads it in full at the start of every
task and `ralph plan` injects it into plan generation, so an uncompacted file
is paid for on every single session. It reached 3,960 lines (~57k tokens) on
one overnight run before being compacted; the compaction step only runs at
wrap-up, which never fires if the run does not finish. See
`.claude/skills/progress-hygiene/SKILL.md`.

## Security posture

- This repo is public and must stay that way for review. Never wire CI to a
  self-hosted runner, and never commit anything that assumes a private host.
- `.claude/worktrees/` is gitignored: it holds live git worktrees belonging to
  a different repository. Git records embedded repos as gitlinks, so staging
  them would publish dangling entries.
- The demo credentials in `services/service-a/src/main.ts` are not secrets and
  do not pretend to be. A deployment reads them from a secret store; this is a
  PoC whose entire database is a seed script.
