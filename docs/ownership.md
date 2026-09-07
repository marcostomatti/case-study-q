# Ownership

Who must approve a change to each path in this repository, and why the team
that *authors* a contract change is usually not the team that *owns* it.

The rules themselves live in [`.github/CODEOWNERS`](../.github/CODEOWNERS).
This document explains what they are for. Where the two disagree, CODEOWNERS
is the one GitHub actually reads.

## Who owns what

| Path                            | Owner           | Role                                            |
| ------------------------------- | --------------- | ----------------------------------------------- |
| `packages/contracts-service-a/` | team A          | Published contract for `service-a`              |
| `services/service-a/`           | team A          | Provider: cards, spend limits, transactions     |
| `apps/web-a/`                   | team A          | Consumer of `service-a`, same team              |
| `packages/contracts-service-b/` | team B          | Published contract for `service-b`              |
| `services/service-b/`           | team B          | Provider of invoices, consumer of `service-a`   |
| `apps/web-b/`                   | team B          | Consumer of `service-a`, across a team boundary |
| `packages/db/`                  | team A + team B | Drizzle schema and migrations                   |
| `packages/contract-tooling/`    | team A + team B | Shared CI machinery: emit, lint, diff, gates    |

Ownership follows the **path**, not the team's job title. Team B owns
`services/service-b/` and is a consumer of `packages/contracts-service-a/` at
the same time. Today's provider is tomorrow's consumer, and the review rules
have to keep working when that flips.

The two shared paths are shared for different reasons. `packages/db/` is jointly
owned because a column rename has to be visible to both teams: the mapping layer
that absorbs it lives inside each service, and — per spec §2.1 — the contract is
deliberately *not* derived from the table, so the database schema is never the
thing that gets published. `packages/contract-tooling/` is jointly owned because
whoever changes a gate changes it for everyone subject to that gate.

## The ownership graph

Three consumer/provider pairs exist on purpose. Each one exercises a different
amount of ceremony:

| Consumer    | Provider    | Crosses a boundary?     | What it demonstrates                      |
| ----------- | ----------- | ----------------------- | ----------------------------------------- |
| `web-a`     | `service-a` | No, same team           | The cheap case. One team, one approval.   |
| `web-b`     | `service-a` | Yes, team B into A      | The governance case this repo exists for. |
| `service-b` | `service-a` | Yes, service to service | Ownership shifts; a provider consumes.    |

`web-a` matters precisely because nothing interesting happens to it. A
governance setup that makes the same-team case expensive is a tax, not a
control.

## Why a consumer opens PRs against a package it does not own

The bottleneck the case study describes is not backend *implementation*
capacity. It is that the backend team is the only party who may **author** the
API definition, so every frontend requirement queues behind backend availability
before a single line of UI can be written against it.

Spec §3 fixes that by separating the two halves of that sentence:

- **Authorship** is open. Anyone may propose a contract change, in the form of a
  pull request against `packages/contracts-service-a/`, including a team that
  owns none of it.
- **Ownership** stays with the provider. The change does not merge until the
  owning team approves it.

So when `web-b` needs a field on the dashboard response, team B writes the
TypeBox schema change themselves and opens the PR. Team A does not have to
schedule the work, only review it. The review is one approval on a small,
mechanically pre-validated diff, not a design meeting — the four blocking gates
in spec §8 have already proven the change emits, lints clean against the house
ruleset, is non-breaking against the last published baseline, and imports
nothing from `packages/db`.

The payoff is in *when* the consumer is unblocked. Merging publishes a new
contract version; the Prism mock is derived from the emitted OpenAPI document,
so it serves the new field immediately. `web-b` builds against it with zero
`service-a` handler code written. The provider implements on its own schedule,
and the consumer switches off the mock when it lands. **The consumer is
unblocked at the merge, not at the deploy** (spec §6.1).

That is also why the diff gate has to be strict. Handing authorship to a party
who does not carry the pager only works if a proposal cannot break the provider
without CI saying so first.

## How the CODEOWNERS requirement enforces spec §3

CODEOWNERS is what turns "providers approve" from a convention into a merge
requirement:

1. A PR touches `packages/contracts-service-a/`.
2. GitHub matches the path against `.github/CODEOWNERS` and requests review from
   the owning team automatically. The author does not have to know who to ask,
   which is the part that quietly decays when ownership is documented in a wiki.
3. With branch protection on `main` requiring review from code owners, the merge
   button stays disabled until an owner approves. Approval from anyone else does
   not satisfy the rule.

This is the human half of tier 2 in spec §4 — the only tier in this PoC that
needs agreement rather than a passing check, and it costs one approval on one
diff. Tiers 0 and 1 are mechanical: CI gates and `client_id` telemetry, no human
in the loop. Tiers 3 and 4 (a schema registry, a review board) stay out of scope
until the triggers in spec §7 fire. The full tier-to-gate mapping is the job of
`docs/governance.md`.

### Two PRs, two different owners

Adopting a contract version is a separate event from changing the contract, and
CODEOWNERS routes the two differently. That separation is what makes spec §9.5
demonstrable:

| PR                                                 | Path touched                    | Who approves |
| -------------------------------------------------- | ------------------------------- | ------------ |
| `web-b` proposes a new field                       | `packages/contracts-service-a/` | team A       |
| `web-b` pins the new version                       | `apps/web-b/package.json`       | team B       |
| `service-b` bumps its pin on `contracts-service-a` | `services/service-b/`           | team B       |

Because consumers pin contract versions exactly and never with a range (spec
§2.2), adoption cannot happen implicitly on someone else's install. It is always
a diff in the consumer's own manifest, owned and reviewed by the consumer's own
team. The friction is the point: that PR is the durable record of which consumer
runs which contract version.

## Three CODEOWNERS behaviours that decide who approves

Worth knowing before editing the rules, because each one fails silently:

- **Last match wins.** Ownership does not accumulate the way `.gitignore`
  patterns do. The final matching line is the only one that applies, so a broad
  pattern added below a specific one silently takes over from it.
- **Two owners on one line means *either* may approve**, not both. Requiring two
  approvals means making the PR touch two paths with disjoint owner sets — which
  is what happens naturally when a change spans `apps/web-b/` and
  `packages/contracts-service-a/`.
- **An unresolvable handle matches nobody, with no error.** No failed push, no
  failed check, no warning. The review requirement simply is not there.

The header comment in `.github/CODEOWNERS` carries the same list next to the
rules it governs.

## Paths with no owner

Everything not listed in CODEOWNERS — the root configs, `tools/`, `scripts/`,
`docs/`, `.github/` itself — has no code owner and needs no specific team's
approval. CODEOWNERS only ever *adds* a review requirement on top of the
repository's default one; it never removes it.

`.github/CODEOWNERS` not owning itself is a real gap rather than an oversight: a
production setup would assign `/.github/` to both teams so that the ownership
map cannot be rewritten by the party it constrains. It is left unowned here
because the handles below are placeholders anyway, and adding a rule that
resolves to nobody would look like a control while being none.

## What is not enforced yet

Two things must be true before any of the above is a gate rather than a
description, and neither is true in this repository today:

1. **The handles are placeholders.** `@marcos-corp/team-a` and
   `@marcos-corp/team-b` use GitHub's `org/team` form to match the
   `@marcos-corp/*` package scope, but this repository belongs to a user
   account, so neither resolves. By the unresolvable-handle behaviour above,
   that means every rule in the file currently requests review from nobody.
2. **Branch protection is not configured.** Without a rule on `main` requiring
   review from code owners, CODEOWNERS suggests reviewers and nothing more.

Both are tracked as human prerequisites in
[`.plans/PREREQUISITES-01-bare-minimal-api-governance-poc.md`](../.plans/PREREQUISITES-01-bare-minimal-api-governance-poc.md).
Stating this plainly is deliberate: an ownership document that reads as if the
approval requirement were live, when it silently matches nobody, is worse than
no document.
