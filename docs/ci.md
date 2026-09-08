# CI: what runs, what it blocks, and how to reproduce it

Every job runs on GitHub-hosted `ubuntu-latest`. This repository is public and
stays that way for review, so nothing targets a self-hosted runner.

Workflow: [`../.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Jobs

| Job | What it runs | What a failure means |
| --- | --- | --- |
| `gates` | `lint:all`, `check-types:all`, `test:all`, `gate:control-bytes` | Ordinary breakage. A Postgres service backs `packages/db`'s integration suite. |
| `contracts` | `bun run pipeline:simulate` | A contract changed in a way the governance rules refuse. |
| `acceptance` | All five spec §9 criteria | The design stopped being demonstrable. |

## The five blocking gates

Per PR touching a contract package, in this order, each blocking.

| # | Gate | Tool | Blocks | Criterion |
| - | ---- | ---- | ------ | --------- |
| 1 | Emit | `emitOpenApi` | A schema that cannot be represented in JSON Schema | — |
| 2 | Lint | `vacuum` | A house-rule violation | — |
| 3 | Diff | `oasdiff` | Any breaking change against the published baseline | §9.2 |
| 4 | Dependency | `assertNoDbImport` | A contract package importing `@marcos-corp/db` | §9.3 |
| 5 | Pins | `assertExactContractPins` | A consumer on a version range | §9.5 |

**The order is a governance decision, not a convenience.** Emit runs first so a
lint error is never reported against a document that could not be built. Diff
runs after lint so a breaking-change report is never computed from a document
that violates the house rules. `runGates` short-circuits at the first failure
and names which gate stopped it.

### House rules the ruleset enforces

From spec §8, in
[`../packages/contract-tooling/rulesets/house.spectral.yaml`](../packages/contract-tooling/rulesets/house.spectral.yaml):

- No typeless or empty (`{}`) schemas — an empty schema passes CI while
  promising nothing.
- `additionalProperties` set explicitly on every object.
- Every enum carries an `unknown` member.
- Anything `deprecated` carries an `x-sunset` date.
- `operationId` on every operation; every error response references the shared
  error schema.
- No `nullable: true` and no `type` array containing `"null"` — absent means
  not applicable.

Each rule has a fixture that violates **that rule and no other**, so a rule that
silently stops matching fails its own test rather than quietly passing
everything.

## Reproducing it locally

```bash
bun run pipeline:simulate
```

Same composition, same order, same binaries. One gap worth naming: **CI pins
the gate binary versions and a workstation does not.** A locally newer `vacuum`
can report a rule violation CI never sees, which reads as a mysterious local
failure. The pinned versions are in
[`../.github/actions/gate-binaries/action.yml`](../.github/actions/gate-binaries/action.yml).

Pinning matters in the other direction too: `vacuum` tightens rules between
releases, so an unpinned install makes the lint gate change its mind between
runs of an unchanged tree — which reads as flakiness rather than as the upgrade
it is.

## Publishing

There is no npm registry in this PoC. "Published" means the emitted document is
committed to `packages/contracts-<svc>/openapi/published/<version>.json`, and
`oasdiff` compares the working emit against the highest published version. That
is the artifact a registry would otherwise hold, and it is what makes gate 3 a
real check rather than a described one.

A test asserts the committed artifact stays byte-identical to a fresh emit. Without
it the committed document drifts from the schemas and the diff gate starts
comparing against fiction.

## Two things the acceptance job checks that are easy to miss

**Every acceptance script asserts green before it mutates.** A script that only
checks the red passes just as happily against gates that reject everything —
including gates broken so badly they fail on an empty document. Two real bugs
were caught by that control alone, both invisible to the red half:

- Gates reported accepting a field removal, because bun caches modules by
  resolved path and a cache-busting query on `emit.ts` does not reach the schema
  modules it imports. The re-emit was returning the original schema. The emit
  now runs in a separate process.
- An assertion read `report.document`, which `runGates` leaves null when handed
  a `specPath` rather than a contract. It was asserting against nothing.

**The job ends with `git diff --exit-code`.** Each script mutates a tracked file
and restores it in a `finally`. A script that crashes mid-mutation leaves the
tree rewritten while still exiting 0 on every other check, so the clean-tree
check is what makes the restoration a claim rather than an intention.

## What CI does not catch

It sees **shape**, not meaning. A field that keeps its name and type while
changing what it means passes every gate here. So does a status code whose
semantics move under it. That is what the tier 2 human approval is for — see
[`governance.md`](governance.md).
