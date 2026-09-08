# Plan: API Contract Governance PoC

## Description

Implements `.specs/01-bare-minimal-api-governance-poc.md`. Read that spec
alongside this plan — this plan argues from it and does not restate its
reasoning.

The deliverable is a bun-workspaces monorepo where a **consumer team can author
a contract change, CI proves the change is safe, the provider team approves it,
and a mock server unblocks the consumer at merge time rather than at deploy
time**. Everything else here exists to make that one workflow demonstrable.

This is a proof of concept for *governance*, not a production API. Handlers may
be thin. The gates may not be.

### The concrete API being governed

`service-a` serves the mobile view in `assets/mobile-view.png` (see
`CASE-STUDY.md`, Appendix 1): a company selector, an invoice-due banner, a card,
a remaining-spend meter reading `5 400/10 000 kr`, three latest transactions
with `54 more items in transaction view`, and two actions. That screen is the
reason the contract has the shape it has.

### Ownership graph the PoC must model

| Consumer    | Provider    | What it proves                                     |
| ----------- | ----------- | -------------------------------------------------- |
| `web-a`     | `service-a` | Same team. No ceremony needed.                      |
| `web-b`     | `service-a` | Cross-team. The actual governance case.             |
| `service-b` | `service-a` | Provider-as-consumer. Ownership shifts.             |

### Target layout

```text
apps/web-a/                      @marcos-corp/web-a
apps/web-b/                      @marcos-corp/web-b
services/service-a/              @marcos-corp/service-a          cards + transactions
services/service-b/              @marcos-corp/service-b          invoices; consumes service-a
packages/contracts-service-a/    @marcos-corp/contracts-service-a
packages/contracts-service-b/    @marcos-corp/contracts-service-b
packages/db/                     @marcos-corp/db                 drizzle schema + migrations
packages/contract-tooling/       @marcos-corp/contract-tooling   ruleset, emit, diff, mock, dep-check
.github/CODEOWNERS
.github/workflows/ci.yml
docker/compose.yaml
scripts/pipeline-simulation.ts
```

`package.json` already declares the `apps/*`, `packages/*`, `services/*`
workspace globs.

## Global Constraints

Copied from the spec and from repository facts. Every task inherits these.

- **Scope is `@marcos-corp/*`.** The spec writes `@org/*` generically.
- **Runtime is bun workspaces**, not pnpm. `packageManager` is pinned; Node 22
  must also be on PATH.
- **Contract packages author schemas in TypeBox and expose them through
  ts-rest.** Never Zod inside `packages/contracts-*`.
- **Zod is the tool for everything internal**: env parsing, request coercion
  after parse, repository-layer shapes, service config. Use it freely inside
  `services/*` and `apps/*`, never inside a contract package.
- **No contract package may import `@marcos-corp/db`** (spec §2.1). A gate
  enforces this.
- **Consumers pin contract versions exactly** — `"1.4.0"`, never `^1.4.0` or
  `~1.4.0` (spec §2.2). A gate enforces this.
- **Every request carries a `client_id`** derived from credentials, logged with
  the endpoint and the contract version (spec §2.3). Never `User-Agent`.
- **Every enum carries an explicit unknown member** and consumers handle it
  (spec §2.5).
- **Requests reject unknown fields; responses tolerate them** (spec §2.5).
- **`null` is never emitted. Absent means not applicable.** One convention,
  encoded in the linter (spec §2.5).
- **Money is integer minor units** plus an ISO-4217 currency code. `5 400 kr`
  is `540000` with `"SEK"`. Never a float, never a preformatted string.
- **This repository is public.** No self-hosted runners. No private-host
  assumptions in any workflow, compose file or script.
- **No Claude attribution** in commit messages or PR bodies.
- Verification order is `bun run lint && bun run check-types && bun run test &&
  bun run gate:control-bytes`. `gate:control-bytes` only sees tracked files.

Prerequisites that a human must satisfy before the loop runs are in
`.plans/PREREQUISITES-01-bare-minimal-api-governance-poc.md`.

The spec §5 toolchain lands as: TypeBox for schema authoring, ts-rest for the
contract shape and typed client/server, `oasdiff` for breaking-change detection,
`@quobix/vacuum` for house-rule linting, Prism for the mock server, and consumer
types taken from the contract package rather than from any generator.

### Where gates run

Both, deliberately. `vacuum` and `oasdiff` are static Go binaries that run on
GitHub-hosted `ubuntu-latest`, so the schema gates are real PR checks — the
acceptance criteria that say "blocked by CI" mean it literally. The same
sequence is reproduced locally by `scripts/pipeline-simulation.ts` against the
`docker/compose.yaml` stack, so the whole thing is demoable offline and without
depending on GitHub.

### Publishing without a registry

There is no npm registry in this PoC. "Published" means: the emitted OpenAPI
document is committed to `packages/contracts-<svc>/openapi/published/<version>.json`,
and `openapi/openapi.json` holds the working emit. `oasdiff` compares the
working emit against the highest published version. That is the artifact a
registry would otherwise hold, and it makes gate 3 a real check rather than a
described one.

---

# Stage: Workspace foundation

Nothing in later stages can be verified until the workspace resolves and the
shared config leaves exist. Each package gets a leaf `eslint.config.mjs`
extending `../../eslint.base.mjs` and a leaf `tsconfig.json` extending
`../../tsconfig.base.json`, matching the pattern the root already uses.

- [x] Create `packages/db` as a bun workspace package named `@marcos-corp/db` with `package.json`, a leaf `tsconfig.json` extending `../../tsconfig.base.json`, a leaf `eslint.config.mjs` extending `../../eslint.base.mjs`, and `lint`/`check-types`/`test` scripts, exporting an empty `src/index.ts` placeholder
- [x] Create `packages/contract-tooling` as a bun workspace package named `@marcos-corp/contract-tooling` with the same four config files and script names as `@marcos-corp/db`
- [x] Create `packages/contracts-service-a` as a bun workspace package named `@marcos-corp/contracts-service-a` at version `0.1.0`, with the same four config files and script names, and add `@sinclair/typebox` and `@ts-rest/core` as dependencies
- [x] Create `packages/contracts-service-b` as a bun workspace package named `@marcos-corp/contracts-service-b` at version `0.1.0`, mirroring the `contracts-service-a` package configuration
- [x] Create `services/service-a` as a bun workspace package named `@marcos-corp/service-a` with the same four config files, an Express dependency, `@ts-rest/express`, and a `dev` script
- [x] Create `services/service-b` as a bun workspace package named `@marcos-corp/service-b`, mirroring the `service-a` package configuration
- [x] Create `apps/web-a` and `apps/web-b` as bun workspace packages named `@marcos-corp/web-a` and `@marcos-corp/web-b`, each a plain TypeScript consumer with no framework dependency, each carrying the same four config files
- [x] Run `bun install` and confirm `bun run lint:all`, `bun run check-types:all` and `bun run test:all` each exit 0 across all eight workspace packages, recording the per-package output lines in the commit message

`bun run --filter '@marcos-corp/*' <script>` prints one prefixed line per
package. A package whose script is a placeholder `echo` also exits 0 — read the
package names in the output, not just the exit code.

---

# Stage: Ownership boundaries

CODEOWNERS is the mechanism that makes "consumers author, providers approve"
real rather than aspirational (spec §3). It lands before any contract exists so
that the first contract PR is already governed.

- [x] Create `.github/CODEOWNERS` assigning `packages/contracts-service-a/` and `services/service-a/` to a team-a owner, `packages/contracts-service-b/` and `services/service-b/` to a team-b owner, `apps/web-a/` to team-a, `apps/web-b/` to team-b, and `packages/db/` plus `packages/contract-tooling/` to both, using GitHub handle placeholders documented in a header comment
- [x] Add `docs/ownership.md` explaining which team owns which path, why a consumer opens PRs against a contract package it does not own, and how the CODEOWNERS review requirement enforces spec §3
- [x] Add `docs/governance.md` mapping each tier in spec §4 onto the CI gate that implements it and what that gate blocks, recording tiers 3 and 4 as out of scope with the triggers from spec §7 that would make them worth adopting, and recording the spec §10 decisions as resolved — TypeBox with ts-rest for contract packages, Zod for everything internal, contract packages versioned independently

---

# Stage: contract-tooling — the house ruleset

`@marcos-corp/contract-tooling` is the shared CI machinery so neither service
reinvents it (spec §3). Build the ruleset before the first contract, so the
first contract is written against a linter that already exists.

The five house rules come from spec §8. Author them as a Spectral-format ruleset
consumed by `vacuum`, which is Spectral-ruleset compatible, actively maintained,
and a single Go binary.

- [x] Add `packages/contract-tooling/rulesets/house.spectral.yaml` carrying all six house rules from spec §8 — reject typeless or empty `{}` schemas, require `additionalProperties` explicitly on every object, require every enum to include an `unknown` member, require an `x-sunset` date on anything marked `deprecated`, require `operationId` on every operation with every error response referencing the shared error schema, and reject `"nullable": true` along with any `type` array containing `"null"` — each rule carrying a description naming the failure it prevents
- [x] Add `packages/contract-tooling/fixtures/` containing one minimal OpenAPI document per house rule that violates exactly that rule and no other, plus one document satisfying every rule
- [x] Add `packages/contract-tooling/src/lint.ts` exporting `lintSpec(specPath: string): Promise<LintResult>` that shells out to `vacuum lint --ruleset` and parses its JSON output into `{ ok: boolean; errors: LintFinding[] }`, with colocated unit tests asserting each fixture in `fixtures/` fails on its own rule and the satisfying document passes

A rule that never fires is worse than no rule, because it reads as coverage. The
fixture-per-rule pairing above is what stops that: each fixture must fail on its
own rule and only its own rule.

- [x] Add `packages/contract-tooling/src/diff.ts` exporting `diffSpecs(basePath: string, revisionPath: string): Promise<DiffResult>` that invokes `oasdiff breaking` and returns `{ breaking: boolean; changes: BreakingChange[] }`, with colocated unit tests covering an additive change (not breaking), a removed field (breaking) and a narrowed type (breaking)
- [x] Add `packages/contract-tooling/src/publishedBaseline.ts` exporting `latestPublishedSpec(contractPackageDir: string): string | null` that returns the path of the highest semver document under `openapi/published/`, with colocated unit tests covering an empty directory, a single version, and correct ordering across `1.9.0` and `1.10.0`
- [x] Add `packages/contract-tooling/src/dependencyCheck.ts` exporting `assertNoDbImport(contractPackageDir: string): DependencyFinding[]` that fails when a contract package declares `@marcos-corp/db` in any dependency field or imports it from any source file, with colocated unit tests covering a clean package, a manifest dependency, a static import and a dynamic `import()`
- [x] Add `packages/contract-tooling/src/pinCheck.ts` exporting `assertExactContractPins(packageDir: string): PinFinding[]` that fails when a dependency on any `@marcos-corp/contracts-*` package uses a range specifier rather than an exact version, with colocated unit tests covering exact, caret, tilde, wildcard and `workspace:*` specifiers
- [x] Add `packages/contract-tooling/src/emit.ts` exporting `emitOpenApi(contract, meta): OpenAPIObject` that builds the OpenAPI document from a ts-rest contract and throws on any schema that cannot be represented, with colocated unit tests asserting a representable contract emits and an unrepresentable one throws with a message naming the offending path
- [x] Add `packages/contract-tooling/src/gates.ts` exporting `runGates(options): Promise<GateReport>` composing `emitOpenApi`, `lintSpec`, `diffSpecs` against `latestPublishedSpec` and `assertNoDbImport` in that fixed spec §8 order, stopping at the first failure and returning a report naming which gate failed and why, with colocated unit tests asserting the order is preserved and that a failure short-circuits every gate after it
- [x] Add an integration test in `packages/contract-tooling/` that runs `runGates` end to end against the satisfying fixture document and asserts a passing `GateReport`, then against a fixture with a removed field and asserts the report names the diff gate

Gate order is fixed by spec §8 and is not an implementation detail: emit failing
first means a lint error is never reported against a document that could not be
built.

---

# Stage: packages/db — Drizzle schema

Owned by the service teams. Explicitly not a dependency of any contract package
(spec §3). This is the schema the contract must *not* be derived from.

Table and column names here are deliberately unlike the contract field names, so
that the mapping layer in `service-a` has something real to translate and a
column rename can be shown to be a non-breaking change.

- [x] Add `packages/db/src/schema/companies.ts` and `packages/db/src/schema/cards.ts` defining Drizzle `companies` and `cards` tables — companies carrying an id, a registered legal name, a display name, an organisation number and a default currency; cards carrying an id, a company foreign key, a last-four column, a card state column deliberately named differently from the contract's field, an activation timestamp and a card art reference — with colocated unit tests asserting both inferred row types
- [x] Add `packages/db/src/schema/spendLimits.ts` and `packages/db/src/schema/transactions.ts` defining Drizzle `spend_limits` and `transactions` tables — spend limits carrying a card foreign key, a limit in integer minor units, a period identifier and a period start; transactions carrying an id, a card foreign key, a company foreign key, a booking timestamp, an integer minor-unit amount, a currency code, a merchant name, a merchant category and a settlement state
- [x] Add `packages/db/src/schema/invoices.ts` defining a Drizzle `invoices` table with an id, a company foreign key, a due date, an integer minor-unit amount, a currency code and a payment state
- [x] Add `packages/db/src/schema/apiUsage.ts` defining a Drizzle `api_usage` table recording an occurrence timestamp, a `client_id`, the operation id, the contract version, the response status and the consuming package name, indexed on `client_id` and on the occurrence timestamp
- [x] Add `packages/db/drizzle.config.ts` and generate the initial SQL migration into `packages/db/drizzle/` with `drizzle-kit generate`, following `.claude/skills/drizzle-orm/rules/making-changes-to-database.md`
- [x] Add `packages/db/src/seed.ts` seeding one company named `Company AB`, one card, a spend limit of `1000000` minor units, transactions summing to `460000` minor units spent so that remaining spend reads `540000` of `1000000`, a total of `57` transactions so that three shown leaves `54 more items`, and one due invoice
- [x] Add a `packages/db` integration test that applies the migrations to a throwaway Postgres database, runs the seed, and asserts the seeded remaining-spend and transaction-count figures match the values rendered in `assets/mobile-view.png`

The seed numbers are load-bearing for the demo. `5 400/10 000 kr` and
`54 more items` are read off the mobile view, so a test that asserts them is
what stops a later schema change from quietly breaking the screenshot the
reviewer compares against.

---

# Stage: contracts-service-a — the published contract

Hand-authored TypeBox. Nothing in this package may import `@marcos-corp/db`
(spec §2.1), contain a `.refine()` or `.transform()` equivalent, or express a
rule the emitted JSON Schema cannot state (spec §2.4).

- [x] Add `packages/contracts-service-a/src/schemas/shared.ts` and `packages/contracts-service-a/src/schemas/error.ts` defining the TypeBox primitives every operation reuses — a monetary amount as an integer minor-unit value paired with an ISO-4217 currency code, an ISO-8601 timestamp string, a pagination envelope, and the shared error schema carrying a machine-readable code, a human-readable message and an optional field path list — each with `additionalProperties` set explicitly
- [x] Add `packages/contracts-service-a/src/schemas/company.ts` and `packages/contracts-service-a/src/schemas/card.ts` defining the company summary schema used by the company selector and the card schema carrying a masked last-four, a card art reference and a card state enum whose members include an explicit `unknown` value
- [x] Add `packages/contracts-service-a/src/schemas/transaction.ts` and `packages/contracts-service-a/src/schemas/dashboard.ts` defining the transaction schema, whose settlement state and merchant category enums each include an explicit `unknown` member, and the aggregated dashboard response containing the selected company, the card, the remaining-spend figure with its limit, the three latest transactions and the count of further transactions
- [x] Add `packages/contracts-service-a/src/contract.ts` defining the ts-rest contract with operations for listing companies, reading a company dashboard, listing transactions with pagination, and activating a card, each carrying an `operationId` and referencing the shared error schema on every error response
- [x] Add `packages/contracts-service-a/scripts/emit.ts` invoking `emitOpenApi` from `@marcos-corp/contract-tooling` and writing `packages/contracts-service-a/openapi/openapi.json`, wired to a `contracts:emit` package script
- [x] Run the emit script and commit `packages/contracts-service-a/openapi/openapi.json` as a build artifact, then copy it to `packages/contracts-service-a/openapi/published/0.1.0.json` as the first published baseline
- [x] Add a `packages/contracts-service-a` test asserting the emitted document passes every house rule in `house.spectral.yaml` and that the emitted document is byte-identical to the committed `openapi/openapi.json`, so a stale committed artifact fails CI
- [x] Add a `packages/contracts-service-a` test asserting `assertNoDbImport` returns no findings for the package, and asserting the package manifest declares no dependency on `@marcos-corp/db`

The byte-identity assertion above is the whole reason to commit a generated
artifact: without it the committed document drifts from the schemas and the diff
gate starts comparing against fiction.

---

# Stage: service-a — provider

Express, ts-rest server, and the mapping layer that keeps the DB schema out of
the contract. Zod is used here for env parsing and post-parse coercion; the
contract schemas remain TypeBox.

- [x] Add `services/service-a/src/config/env.ts` parsing the service environment with a Zod schema covering the database URL, the port and the contract version string, failing at startup with a readable message when a variable is missing
- [x] Add `services/service-a/src/auth/clientIdentity.ts` resolving a `client_id` from request credentials, rejecting any request without one, and exposing it on the request context, with colocated unit tests covering a missing credential, an unknown credential and a valid credential
- [x] Add `services/service-a/src/telemetry/usageLogger.ts` writing one `api_usage` row per request recording the `client_id`, the operation id, the contract version and the response status, with colocated unit tests asserting a row is written for both a success and an error response
- [x] Add `services/service-a/src/mapping/cardMapper.ts` and `services/service-a/src/mapping/transactionMapper.ts` translating Drizzle card and transaction rows into their contract types, mapping the differently-named database state column onto the contract enum and mapping any unrecognised database value onto the enum's `unknown` member, with colocated unit tests covering every known state of both and one unrecognised value each
- [x] Add `services/service-a/src/mapping/dashboardMapper.ts` assembling the dashboard response from company, card, spend-limit and transaction rows, computing remaining spend as the limit minus the sum of settled transaction amounts, with colocated unit tests asserting the figures match the seeded `540000` of `1000000`
- [x] Add `services/service-a/src/repositories/` query functions returning Drizzle row types for companies, cards, spend limits and transactions, with colocated unit tests run against a throwaway Postgres database
- [x] Add `services/service-a/src/routes/` ts-rest route implementations for every operation declared in the contract, rejecting unknown request fields and returning the shared error schema on every error path
- [x] Add `services/service-a/src/server.ts` composing the env config, the client identity middleware, the usage logger and the ts-rest router into an Express application, exporting a factory so tests can bind an ephemeral port
- [x] Add an integration test in `services/service-a/` asserting a request without a `client_id` is rejected, a request carrying an unknown request field is rejected, a well-formed dashboard request returns a payload validating against the contract schema, and the transactions endpoint paginates across the seeded 57 transactions while the dashboard reports 54 further items

Binding the test server to loopback on an ephemeral port avoids the port-steal
flakes that a fixed port produces on macOS.

---

# Stage: contracts-service-b and service-b — provider as consumer

`service-b` is required by spec §1: it proves that today's provider is
tomorrow's consumer, and that a pinned contract dependency is reviewable in
exactly the same way whether the consumer is an app or a service.

- [x] Add `packages/contracts-service-b/src/schemas/invoice.ts` defining the invoice schema with a payment state enum including an explicit `unknown` member, and `packages/contracts-service-b/src/contract.ts` declaring an operation returning the due invoice for a company
- [x] Add `packages/contracts-service-b/scripts/emit.ts`, run it, commit both `openapi/openapi.json` and `openapi/published/0.1.0.json`, and add a test asserting the emitted document passes every house rule and stays byte-identical to the committed artifact
- [x] Add `services/service-b/package.json` declaring `@marcos-corp/contracts-service-a` at the exact version `0.1.0` with no range specifier, alongside its own `@marcos-corp/contracts-service-b` dependency
- [x] Add `services/service-b/src/clients/serviceAClient.ts` building a ts-rest typed client from `@marcos-corp/contracts-service-a`, sending its own `client_id`, and tolerating unknown response fields, with colocated unit tests asserting an unknown field in a stubbed response does not cause a failure
- [ ] Add `services/service-b/src/routes/` implementing the due-invoice operation, resolving company context through the `service-a` client, with colocated unit tests using a stubbed `service-a` response
- [ ] Add an integration test in `services/service-b/` asserting the due-invoice endpoint returns a payload validating against the `contracts-service-b` schema when `service-a` is served by the mock

A stub-backed client test silently hits the real service when the base URL
override is missed. Assert the stub actually received the request rather than
only asserting the returned value.

---

# Stage: web-a and web-b — consumers

Deliberately thin. The case study states client-side work is not expected, so
these exist to prove pinning, response tolerance and unknown-enum handling —
not to render anything.

- [x] Add `apps/web-a/package.json` declaring `@marcos-corp/contracts-service-a` at the exact version `0.1.0`, and `apps/web-a/src/dashboardClient.ts` building a typed ts-rest client for the dashboard operation
- [x] Add `apps/web-b/package.json` declaring `@marcos-corp/contracts-service-a` at the exact version `0.1.0`, and `apps/web-b/src/dashboardClient.ts` building its own typed client sending a distinct `client_id`
- [x] Add a test in `apps/web-b/` asserting the client ignores an unrecognised field present in a stubbed dashboard response, proving the response-tolerance half of spec §2.5
- [x] Add a test in `apps/web-b/` asserting the client maps an unrecognised card state value onto the enum's `unknown` member and continues, rather than throwing, proving the unknown-enum requirement of spec §2.5

---

# Stage: The demo stack

`docker/compose.yaml` runs Postgres, the Prism mock derived from the emitted
contract, and `service-a`. This is what makes the workflow demoable in the
30-minute slot without depending on GitHub, and what `pipeline-simulation` runs
the gates against.

- [x] Add `docker/compose.yaml` defining a Postgres service with a pinned image tag, a healthcheck and a named volume, reading its credentials from environment variables with local-only defaults
- [x] Add a `mock-service-a` service to `docker/compose.yaml` running Prism against `packages/contracts-service-a/openapi/openapi.json`, mounted read-only, so the mock serves the contract before any implementation exists
- [x] Add a `service-a` service to `docker/compose.yaml` depending on the Postgres healthcheck, and document in `docker/README.md` which ports each service binds and why no service binds to a non-loopback interface
- [x] Add `scripts/pipeline-simulation.ts` running the four blocking gates in spec §8 order against every contract package and printing a per-gate pass or fail summary with a non-zero exit on the first failure, wired to a `pipeline:simulate` root script
- [x] Add `scripts/demo.ts` bringing up the compose stack, applying migrations, running the seed, and printing the mock and service URLs, wired to a `demo:up` root script
- [ ] Add a test for `scripts/pipeline-simulation.ts` asserting that a deliberately broken contract fixture causes a non-zero exit and that the failing gate is named in the output

Compose gives shell environment precedence over an `--env-file`, so a stray
exported variable in the demo shell silently overrides the file. Read the
effective config with `docker compose config` before trusting it.

---

# Stage: CI

The same gates, on GitHub-hosted runners. Nothing here may reference a
self-hosted runner.

- [x] Add `.github/workflows/ci.yml` with a job running `bun install`, `bun run lint:all`, `bun run check-types:all`, `bun run test:all` and `bun run gate:control-bytes` on `ubuntu-latest`
- [x] Add a `contracts` job to `.github/workflows/ci.yml` installing pinned `vacuum` and `oasdiff` binaries and running the four blocking gates in spec §8 order against every contract package, triggered on pull requests touching a contract package
- [x] Add a `pins` job to `.github/workflows/ci.yml` running `assertExactContractPins` across every consuming package, so a caret or tilde specifier on a contract dependency fails the pull request
- [ ] Add a publish step to `.github/workflows/ci.yml` that, on merge to `main`, copies the emitted document to `openapi/published/<version>.json` when the contract package version has been bumped, and fails when the contract changed without a version bump
- [x] Add `docs/ci.md` documenting each gate, what it blocks, which acceptance criterion it serves, and how to reproduce it locally with `bun run pipeline:simulate`

---

# Stage: Acceptance criteria

Spec §9 lists five things that must be demonstrable. Each becomes an executable
check, so the demo does not depend on narration.

- [x] Add `scripts/acceptance/01-consumer-adds-field.ts` scripting the spec §6.1 unblocking workflow, which spec §9.1 is the acceptance criterion for — a consumer-authored additive field on `contracts-service-a`, gates passing, version bumped to `0.2.0`, published baseline written, and the Prism mock serving the new field with no `service-a` handler written
- [x] Add `scripts/acceptance/02-removal-is-blocked.ts` scripting spec §9.2 — a field removal from `contracts-service-a` producing a non-zero exit whose message names the removed field and the operation it breaks
- [x] Add `scripts/acceptance/03-db-derived-export-is-blocked.ts` scripting spec §9.3 — a contract package exporting a Drizzle-derived schema, and the dependency-check gate rejecting it with a message naming the offending import
- [x] Add `scripts/acceptance/04-usage-query.ts` scripting spec §9.4 — a SQL query over `api_usage` returning which `client_id` called which operation at which contract version over the last 30 days, run after driving traffic from `web-a`, `web-b` and `service-b`
- [x] Add `scripts/acceptance/05-pin-bump-is-reviewable.ts` scripting spec §9.5 — `service-b` pinned to `contracts-service-a` at an exact version, with a bump producing a diff confined to a manifest and a CODEOWNERS-reviewable path
- [ ] Add a test asserting each of the five acceptance scripts exits with the expected code, so an acceptance script that silently stops proving anything fails CI
- [ ] Add `docs/breaking-changes.md` documenting the spec §6.2 major-version procedure — oasdiff fails the provider's PR, the provider either makes the change additive or opens a major version, a major version requires a migration note in the contract package plus the affected-consumer list pulled from `api_usage`, and the old version stays published — and the spec §6.3 registration flow where a new consumer is issued a `client_id` with a named owner and the provider is informed rather than asked
- [ ] Add `docs/field-retirement.md` documenting the spec §6.4 retirement flow — deprecate with an `x-sunset` date, query `api_usage` by `client_id` for the field, notify named owners, remove only at zero usage — and noting that the 13-month retention in spec §6.4 is a documented requirement rather than something the PoC's retention implements

Retirement is documented rather than exercised because spec §6.4 includes it so
the design can answer the question, not because the PoC has a field old enough
to retire. Recording that distinction is honest; silently shipping a retirement
script that never runs is not.

---

# Stage: Close-out

- [x] Update `README.md` Task 2 sections with the database schema rationale, the payload-shape rationale for the aggregated dashboard endpoint, and the API structure, each linking to the code that implements it
- [x] Add `docs/demo-script.md` walking the 30-minute demo in order — bring the stack up, show the consumer-authored PR passing gates, show the mock serving it, show the removal being blocked, show the usage query — with the exact commands for each beat
- [x] Update `AGENTS.md` with the populated workspace map, the per-package conventions that landed, and the verification order including `bun run pipeline:simulate`
- [x] Run the full verification order plus `bun run pipeline:simulate` and record every gate's exit code and output in the close-out notes
- [ ] Take the mergeability reading with `git merge-tree --write-tree origin/main HEAD` and assemble the close-out notes covering the gate captures, the test plan and any recorded debt

The runner opens the pull request after the final task. This plan deliberately
carries no task that opens one — two openers race, and a measured run once cut a
second branch and opened a second pull request for a single plan.
