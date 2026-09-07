# Governance tiers, as gates

A tier is a **coordination cost**: how many parties must agree before a change
ships. [`PRESENTATION.md`](../PRESENTATION.md) defines the five tiers in those
terms. Spec §4 restates them as things CI actually does, and this document
carries that restatement down to the file that implements each one.

Read it as the answer to one question per tier: *what does this cost, and what
does it stop?* The per-gate operational reference — exact commands, exit codes,
how to reproduce a CI failure locally — is `docs/ci.md`. Ownership and the
approval routing sit in [`docs/ownership.md`](ownership.md).

## The map

| Tier | Coordination cost              | Implemented by                                     | Blocks                        | Human agreement    |
| ---- | ------------------------------ | -------------------------------------------------- | ----------------------------- | ------------------ |
| 0    | None. Unilateral.              | Four blocking CI gates on the contract package      | The provider's own PR         | No                 |
| 1    | None. Consumers have no say.   | `client_id` on every request, logged to `api_usage` | Nothing. Observability only.  | No                 |
| 2    | One approval, one team.        | CODEOWNERS on the contract package + exact pins     | The consumer's adoption PR    | Yes — one approval |
| 3    | Infrastructural, cross-domain. | —                                                   | —                             | Out of scope (§7)  |
| 4    | Organizational.                | —                                                   | —                             | Out of scope (§7)  |

Tiers 0 and 1 are prerequisites, not options: every tier above them reads their
output. Tier 2 is the only tier in this PoC that spends a human.

## Tier 0 — mechanical, and it blocks the provider

Tier 0 is what a team owes itself. No consumer is consulted, nothing is
negotiated, and the whole tier is a sequence of checks that either pass or fail
on the PR that caused them.

Per PR touching a contract package, in the fixed spec §8 order:

| # | Gate             | Implemented by                                            | Fails the PR when                                                                  |
| - | ---------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1 | Emit             | `emitOpenApi` — `packages/contract-tooling/src/emit.ts`    | a schema cannot be represented in the emitted document (spec §2.4)                  |
| 2 | Lint             | `lintSpec` — vacuum against `rulesets/house.spectral.yaml` | any of the six house rules below is violated                                        |
| 3 | Diff             | `diffSpecs` — oasdiff against `latestPublishedSpec`        | the change is breaking against the highest published baseline                       |
| 4 | Dependency check | `assertNoDbImport`                                         | a contract package declares or imports `@marcos-corp/db` (spec §2.1)                |
| 5 | Publish          | CI step on merge to `main`                                 | the contract changed without a version bump                                         |

The order is part of the design, not an implementation detail. Emit runs first
so that a lint error is never reported against a document that could not be
built, and the run short-circuits at the first failure so the report names one
cause rather than a cascade.

The six house rules the linter enforces, each preventing a specific silent
break:

- **No typeless or empty `{}` schemas.** An empty schema publishes as "anything
  goes" while reading as a contract.
- **`additionalProperties` set explicitly on every object.** The default is
  permissive, so leaving it off is a decision nobody made.
- **Every enum carries an explicit unknown member.** Otherwise adding an enum
  value is a silent break on every consumer (spec §2.5).
- **Anything `deprecated` carries an `x-sunset` date.** Deprecation without a
  date never ends.
- **`operationId` on every operation, and every error response references the
  shared error schema.** Usage telemetry keys on `operationId`; an operation
  without one is invisible to tier 1.
- **No `"nullable": true`, and no `type` array containing `"null"`.** One
  convention, encoded in the linter: `null` is never emitted, and absent means
  not applicable.

### What "published" means here

There is no npm registry in this PoC. The published artifact is the emitted
OpenAPI document committed to
`packages/contracts-<svc>/openapi/published/<version>.json`, with
`openapi/openapi.json` holding the working emit. The diff gate compares the
working emit against the highest published version. That is the artifact a
registry would otherwise hold, which is what makes gate 3 a real check rather
than a described one — and it is why a stale committed artifact is itself a CI
failure: the emitted document must stay byte-identical to what the schemas
produce, or the diff gate starts comparing against fiction.

### Where tier 0 runs

Both in CI and locally. vacuum and oasdiff are static Go binaries that run on
GitHub-hosted `ubuntu-latest`, so "blocked by CI" means it literally. The same
sequence is reproduced offline by `bun run pipeline:simulate` against the
`docker/compose.yaml` stack, so the workflow is demoable without depending on
GitHub.

### What tier 0 does not catch

It sees **shape**, not meaning. A field that keeps its name and type while
changing what it means passes every gate here. So does a status code whose
semantics move under it. Tier 0 buys mechanical compatibility and nothing more;
the semantic half is what the tier 2 approval is for.

## Tier 1 — blocks nothing, and is load-bearing anyway

Every request carries a `client_id` derived from credentials — never
`User-Agent` — and `services/service-a/src/telemetry/usageLogger.ts` writes one
`api_usage` row per request recording the `client_id`, the `operationId`, the
contract version and the response status.

Nothing is blocked. Nothing is approved. The tier exists because **none of it
can be added retroactively**: the history it accumulates is the input to
decisions taken at higher tiers.

| Question asked later          | Answered from `api_usage`                          | Spec  |
| ----------------------------- | -------------------------------------------------- | ----- |
| Who breaks if I remove this?  | `client_id`s calling the operation, by version     | §6.2  |
| Who do I notify?              | the named owner registered with each `client_id`   | §6.3  |
| Is this field retired yet?    | usage is zero, per consumer, over the window       | §6.4  |
| Which consumer is on 1.4.0?   | contract version recorded on every request         | §9.4  |

Acceptance criterion §9.4 — which `client_id`s called which endpoint at which
contract version over the last 30 days — is the executable form of this tier.
With three consumers it is trivially answerable by asking around; the point is
that the query keeps working when there are thirty and nobody knows them all.

## Tier 2 — one approval, from the team that carries the pager

This is the tier the case study is actually about. The bottleneck it describes
is not backend implementation capacity — it is that the provider is the only
party who may *author* the API definition, so every consumer requirement queues
behind provider availability.

Tier 2 splits authorship from ownership, and has a mechanical half and a human
half:

| Half       | Mechanism                                                              | Blocks                                              |
| ---------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| Human      | CODEOWNERS on `packages/contracts-*` + branch protection on `main`      | the contract change, until an owning team approves   |
| Mechanical | Exact version pins (spec §2.2), enforced by `assertExactContractPins`   | the consumer's adoption PR, if it uses `^` or `~`    |

The human half is why a consumer may open a PR against a contract package it
does not own: anyone may propose, only the owner may merge. The routing and the
CODEOWNERS behaviours that decide who approves are in
[`docs/ownership.md`](ownership.md).

The mechanical half is what stops adoption from happening by accident. Because
consumers pin `"1.4.0"` and never `"^1.4.0"`, a new contract version cannot
arrive on somebody else's install — it is always a diff in the consumer's own
manifest, reviewed by the consumer's own team. The friction is the point: that
PR is the durable record of which consumer runs which contract version, and it
is what makes acceptance criterion §9.5 demonstrable.

What tier 2 costs is one approval on a diff that four gates have already
mechanically validated. What it buys is that the consumer is unblocked at the
**merge** rather than at the deploy: merging publishes a new contract version,
the Prism mock is derived from the emitted document, and the consumer builds
against the new field with zero provider handler code written (spec §6.1).

## Tiers 3 and 4 — out of scope, with the triggers that change that

Neither tier is implemented, and that is a decision rather than an omission.
Spec §4 is explicit: **tier 3 may never be needed for a pure TypeScript stack.**
A pinned contract package plus the tier 0 gates already covers what a schema
registry would — mechanical compatibility, checked centrally, before anyone
consumes the change.

Adopting either tier before its trigger costs coordination and buys nothing,
and makes the whole system look like bureaucracy — which poisons it for when it
is actually needed.

The triggers are spec §7:

| Deferred                          | Tier | Adopt when                                               |
| --------------------------------- | ---- | -------------------------------------------------------- |
| Pact / CDC broker                 | 3    | A consumer is outside the monorepo, or non-TypeScript    |
| Schema registry (Apicurio et al.) | 3    | A non-TS producer exists, or events over Kafka appear    |
| Generated SDKs (Fern / Stainless) | 3    | An external partner needs a published SDK                |
| Date-based / header versioning    | 3    | A consumer whose release cadence you don't control       |
| API review board                  | 4    | Two teams want incompatible changes to the same resource |

Spec §4 names only two of these by tier — registry (3) and review board (4).
The rest are placed by the coordination they would introduce: the first four
all become necessary at the moment enforcement has to reach outside a single
TypeScript monorepo, which is the definition of tier 3 in `PRESENTATION.md`.
The last one is different in kind — it is not a tool, it is a standing
cross-functional body, and it is only worth its cost when two teams want
mutually incompatible changes to the same resource and no amount of tooling can
decide between them.

Every trigger above is an event someone will notice. None of them is a date, a
maturity level, or a quarterly review — which is deliberate, because those are
the conditions under which governance gets adopted for its own sake.

## Decisions from spec §10, resolved

Spec §10 lists three questions as "not for the agent to resolve". They are
resolved here, along with the two implied choices that follow from them, so
that the rest of the repository has one answer to point at rather than a
convention each package rediscovers.

| Question                                            | Resolved as                                        | Why                                                                             |
| --------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| §10.1 TypeBox vs Zod-with-guardrails for contracts  | **TypeBox**                                        | The schema *is* JSON Schema; no lossy conversion step to get wrong               |
| §10.2 ts-rest vs oRPC                               | **ts-rest**                                        | More conservative; one contract yields typed client, typed server and the emit   |
| §10.3 `client_id` issuance manual or onboarding flow | **Manual, with a named owner**                     | §6.3 is registration, not approval — the provider is informed, not asked         |
| Where Zod belongs                                   | **Everything internal, never in a contract package** | It is the better parser; §2.4 is about what can be *published*, not about Zod    |
| How contract packages are versioned                 | **Independently, one version per package**         | A bump is a statement about one service's API and must not implicate the others  |

### TypeBox with ts-rest, inside `packages/contracts-*`

TypeBox is the default because it makes spec §2.4 **structural rather than a
convention someone has to remember**. There is no `.refine()` to reach for, so
a cross-field rule that the emitted JSON Schema cannot state has nowhere to
hide; it goes into `if`/`then` or `dependentRequired`, or into the error
catalogue, where oasdiff can see it. With Zod the same discipline is
achievable — `z.toJSONSchema()` with `unrepresentable: "throw"`, never
`"any"` — but it is a flag someone can quietly relax, and `"any"` emits `{}`
and passes the build with a contract that says nothing.

ts-rest over oRPC is the conservative reading rather than the exciting one. One
contract definition produces the typed client that consumers import, the typed
server that the provider implements, and the OpenAPI document that gate 1
emits. Consumers take their types from the contract package, not from a
generator: there is no generated-SDK step to drift.

### Zod for everything internal

Zod is not banned anywhere outside `packages/contracts-*`, and should be used
freely inside `services/*` and `apps/*`:

- environment parsing, failing at startup with a readable message
- request coercion *after* parse, where domain transformation belongs
- repository-layer shapes and service configuration

The restriction is narrow and has one reason: a contract package's output is
published, and anything a published document cannot state does not exist as far
as consumers are concerned. Nothing about internal validation shares that
constraint.

### Contract packages versioned independently

Each `packages/contracts-<svc>` carries its own `version` and its own
`openapi/published/` directory. There is no repo-wide version and no lockstep
release.

The alternative — one version across every contract package — would force every
consumer of `contracts-service-b` through a pin bump and a review for a change
that cannot possibly affect them, and in doing so would destroy the property
that makes the pin useful: that a bump in a consumer's manifest is evidence
something in *its* provider's contract moved. Independent versioning keeps the
adoption PR meaningful and keeps blast radius equal to the contract that
actually changed.

The consequence worth stating plainly: **a contract package's version number is
API surface, not bookkeeping.** Consumers pin it exactly, a gate enforces that
they do, and the publish step fails a changed contract that did not bump it.
Bumping it is the reviewable event, so it is never a routine chore.

## Not enforced yet

Two statements above describe requirements rather than running code. Recording
which is which is the honest version of a governance document:

1. **Tier 2's human half is inert.** The team handles in
   [`.github/CODEOWNERS`](../.github/CODEOWNERS) are placeholders that resolve
   to nobody on a user-account repository, and branch protection requiring
   code-owner review is not configured. Until both are fixed, CODEOWNERS
   suggests reviewers and blocks nothing. Both are tracked in
   [`.plans/PREREQUISITES-01-bare-minimal-api-governance-poc.md`](../.plans/PREREQUISITES-01-bare-minimal-api-governance-poc.md),
   and `docs/ownership.md` says the same thing at more length.
2. **Tier 1's retention is not implemented.** Spec §6.4 requires at least 13
   months of usage rollups, because quarterly and annual consumers are
   invisible in a 30-day window. The `api_usage` table stores rows; nothing
   rolls them up and nothing expires them. The 13 months is a documented
   requirement this PoC states and does not satisfy.

Where this document and CI disagree, CI is the one that decides whether a
change merges.
