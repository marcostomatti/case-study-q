# API Schema and Versioning strategy
Below I include a short summary and description of my interpretation of the case study requirements, as well as my proposed solution to the problem of improving collaboration between frontend and backend developers.

## Pain points and bottlenecks:
All mentioned issues can be boiled down to 3 complaints between competencies/teams:
1. Scarcity: skill to specify and support APIs is a bottleneck. PMs can't write technical detail, and junior devs need it written for them.
2. Sequencing: API definition lands too late in the software development lifecycle, which slows down frontend work.
3. Blocking: competent frontend devs sit waiting and they want parallel work.


## Hard constraints:
| Constraint          | Description                  |
| ------------------- | ---------------------------- |
| Stack               | Node.js + TypeScript (fixed) |
| Database            | Local Mock                   |
| Client-side work    | Not expected                 |
| Time budget         | 4–6 hours                    |
| Presentation + demo | 30 minutes total, combined   |

## Granted assumptions: 
- Unlimited budget (except for time budget I guess...)
- Full decision-making control, senior management backing. 
  
## My interpretation and assumptions:

- PMs role: My initial struggle was to identify the intention behind of the PM mention in the case study. I tried to identify if the PM's role was simply not relevant to the problem space, the source of the problem or a symptom. My interpretation is that:
  - PMs are the source of requirements (inter team collaboration). They are not required to provide or define low level (technical) API or data requirement.
  - PMs are not the root cause, but their potential competency gap is. They may lack the technical knowledge to describe the API implementation details for less experienced developers.

- FE devs role: The frontend developers are competent so they could understand the needed API requirements but they still need BE to implement these.

### Challenge dissection
Understanding that a challenge is only the result of an expectation meeting a reality, is the first step to resolve them. Knowing who owns the reality and who's expectations are unmet is the key to bridge the gap between both efficiently. Here's my interpretation of who owns each problem/symptom and what role they play in the argument. 

| Challenge                                          | Ownership (who's problem)   | Role                                                 |
| -------------------------------------------------- | --------------------------- | ---------------------------------------------------- |
| APIs built constantly                              | Organization                | This is the core context, and establishes the volume |
| Competence specificity for APIs                    | Senior/BE                   | Root cause                                           |
| App has no API                                     | FE                          | Symptom (this is what I'm supposed to fix)           |
| API definition happens too late                    | Planning/PM + BE            | Root cause                                           |
| PMs can't describe technical detail to junior devs | junior dev inherits from PM | Root cause                                           |
| FE devs frustrated by delays                       | FE                          | Symptom                                              |
| Want parallel work                                 | Org                         | Main Goal                                            |



## Deliverables

### Task 1: Presentation

Look [here](./PRESENTATION.md) for the presentation deliverable. I spent 3~4hs in research and writing the ideal implementation. Research consisted in some practical and small implementations to check usability and ideal combination without going outside of a reasonable scope for the implementation. 

### Task 2: API Implementation

1. Based on the presentation I created a [technical feature spec](.specs/01-bare-minimal-api-governance-poc.md) with feature requirements, extra context and alternatives on implementation if required. 
2. From the spec I generated a [detailed plan](.plans/PLAN-01-bare-minimal-api-governance-poc.md).
The actual code implementation was executed via a ralph loop triggering individual agent sessions on a per task basis. 
3. For this I ported some tooling/scripts I made for some of my personal projects. I intended to save time as I was already reaching the 5hs marker, and I was genuinely tempted to check how the tooling performed on a bare minimal project from scratch with little existing context other than requirements.

> [!note] During the execution I identified interesting issues with how the loop behaved in this project. 
> For example:
> - This [context files](./progress.txt) bloated way beyond expectation (in [this historical](https://github.com/marcostomatti/case-study-q/blob/cb26e227a0f086179b586f2a0434b396d05144b2/progress.txt) commit it reached ~4k lines) that [some skills](.claude/skills/progress-hygiene/SKILL.md) specifically should have capped early on. 
> - Found some over engineered bits around auth and security checks, way beyond a PoC implementation, eg: something that could have easily been a mock with a comment. The main driver were seamingly simple, rather innocuous skill rules that are not as impactful on a fully implemented project. Thats the case of [this client identity checks](services/service-a/src/auth/clientIdentity.ts). This is initially the product of a [simple skill rule](services/service-a/src/auth/clientIdentity.ts#L26) that I brought from my project. In my project only ensure an existing middleware is introduced. Here, this instruction called my over protective auth and security agents from my user scope and started building everything that was missing. 
> 
> These findings ultimately prompted some fixes and improvements on the tooling that will soon be available back in my [source project](https://github.com/marcostomatti/template-agentic-research).

## Setup

```bash
git clone git@github.com:marcostomatti/case-study-q.git
cd case-study-q
bun install
```

That alone runs the linter, the type checker and the byte gate. Three things
unlock the rest:

| Needed for                         | Install                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| The full test suite                | Docker (see **Database** below)                                                                            |
| The schema gates                   | `brew install daveshanley/vacuum/vacuum`, then `brew tap oasdiff/homebrew-oasdiff && brew install oasdiff` |
| The demo stack and the usage query | Docker Desktop running                                                                                     |

Both binaries are single static Go files — no runtime, no service. CI installs
the same pinned versions from
[`.github/actions/gate-binaries`](./.github/actions/gate-binaries/action.yml);
match them locally, because a newer `vacuum` reports rule violations CI does
not.

### Database

`bun run test:all` needs a Postgres. Fourteen of the tests are integration
tests that migrate a real database, seed it, and read the mobile view's figures
back out — `5 400/10 000 kr` and `54 more items` are asserted against SQL, not
against a mock. Without a database those fourteen are **skipped and the run is
red**, deliberately: a missing database must not be mistakable for a passing
suite.

One Postgres serves the whole project. It is the same container the demo uses,
started on its own:

```bash
bun run db:up     # just Postgres, from docker/compose.yaml
bun run db:down   # stop it and drop the volume
```

Then point the suites at it:

```bash
export TEST_DATABASE_URL='postgres://governance:governance@127.0.0.1:55432/governance'
bun run test:all
```

**One instance, separate databases.** The suites never write to `governance` —
they create a uniquely named throwaway database per run and drop it afterwards,
so a test run and a demo can share the server without touching each other's
data. `POSTGRES_USER` is that instance's superuser, which is what lets the
suites `CREATE DATABASE`; fine for a PoC whose entire dataset is a seed script,
where a real deployment would issue a role with `CREATEDB` and nothing else.

If Postgres is already installed locally, you can skip Docker entirely — with
`initdb` and `pg_ctl` on `PATH` the suites stand up a private cluster on a unix
socket and throw it away afterwards. `TEST_DATABASE_URL` takes precedence when
both are available.

`bun run demo:up` starts this same Postgres plus the mock and the service, so
there is no need to run both `db:up` and `demo:up`.

## Reproducing a green pipeline

Two separate things, deliberately. **Hygiene** — no gate binaries, no mock, no
service; a Postgres for the integration tests is the only thing it needs beyond
`bun install`:

```bash
bun run db:up
export TEST_DATABASE_URL='postgres://governance:governance@127.0.0.1:55432/governance'
bun run lint:all && bun run check-types:all && bun run test:all && bun run gate:control-bytes
```

**The gates** are the cross-team schema governance, and are the only thing that
needs the two binaries:

```bash
bun run test:gates:all     # do the house rules actually fire
bun run pipeline:simulate  # emit -> lint -> diff -> dependency -> version -> pins
```

Expected tail:

```text
Pin gate — spec §2.2: exact versions, no ranges
  PASS  @marcos-corp/web-a
  PASS  @marcos-corp/web-b

PASSED — every gate green.
```

No Docker, no database, no running service — the gates are static analysis over
the emitted OpenAPI document. Measured at **0.54s with zero containers**.

The full demo, which does need Docker:

```bash
bun run demo:up                                 # Postgres + Prism mock + service-a
bun scripts/acceptance/04-usage-query.ts        # who called what, at which version
docker compose -f docker/compose.yaml down -v   # teardown
```

## Reproducing a gate trigger

Every gate below can be fired on demand. Each script mutates a tracked file,
asserts the refusal, and **restores the file in a `finally`** — so the working
tree is clean afterwards. Each also asserts the gates are green *before* it
mutates, because a script that only checks the red passes just as happily
against gates that reject everything.

```bash
bun scripts/acceptance/02-removal-is-blocked.ts            # gate 3, breaking change
bun scripts/acceptance/03-db-derived-export-is-blocked.ts  # gate 4, db-derived schema
bun scripts/acceptance/05-pin-bump-is-reviewable.ts        # pin gate, version range
bun scripts/acceptance/01-consumer-adds-field.ts           # the control: additive PASSES
```

Expected from the removal script — note that it names the property and both
operations it breaks:

```text
  OK    gates reject the removal
  OK    the DIFF gate is what rejected it, not lint or emit
  OK    the message names the removed field (`artUrl`)
          response-required-property-removed (getCompanyDashboard): removed the
          required property `card/artUrl` from the response with the `200` status
```

### Firing a gate by hand

To see one outside a script, edit the contract and run the pipeline:

```bash
# Remove any property from packages/contracts-service-a/src/schemas/card.ts
bun run pipeline:simulate     # FAIL diff — oasdiff names the break
git checkout -- packages/contracts-service-a
```

The **version gate** is the one that makes an exact pin mean anything, and it
fires on a change the other four accept:

```bash
# Add an optional field to packages/contracts-service-a/src/schemas/company.ts
bun run --filter '@marcos-corp/contracts-service-a' contracts:emit
bun run pipeline:simulate     # PASS diff (additive) but FAIL version
git checkout -- packages/contracts-service-a
```

Additive, non-breaking, lints clean — and still refused, because the version
stayed `0.1.0`. Without that gate the bytes published under a version can change
while the version does not, and every consumer pinned there silently receives a
contract it never reviewed.

To ship that change properly:

```bash
# bump version in packages/contracts-service-a/package.json to 0.2.0
bun run --filter '@marcos-corp/contracts-service-a' contracts:emit
bun run pipeline:simulate            # green: diff is additive, version is higher
bun run contracts:publish --write    # advance the baseline
```

Publish **after** the pipeline, never before — publishing first moves the
baseline `oasdiff` compares against, and every change then looks non-breaking.

---

Walkthrough for a live demo: [`docs/demo-script.md`](./docs/demo-script.md).

The implementation serves the Appendix 1 screen, but the thing being
demonstrated is the *governance* around it: consumers author contract
proposals, providers approve and own them, and a mock derived from the contract
unblocks the consumer at merge rather than at deploy. The design input is
[`.specs/01-bare-minimal-api-governance-poc.md`](./.specs/01-bare-minimal-api-governance-poc.md);
the tier-to-gate mapping is [`docs/governance.md`](./docs/governance.md).

#### Database Schema and Payload Response

**The database schema is not the payload, and that separation is the point.**

`packages/db` holds six Drizzle tables — `companies`, `cards`, `spend_limits`,
`transactions`, `invoices`, `api_usage`. Their column names deliberately do not
match the contract's field names. A mapping layer in `services/service-a/src/mapping/`
translates between the two, and that layer is where a column rename stops being
a breaking change.

This is the one rule the whole design is built around. `drizzle-typebox` would
happily generate contract schemas straight off these tables — and doing so
publishes your database to every consumer, so every migration becomes a
potential contract break. CI blocks it:
`bun scripts/acceptance/03-db-derived-export-is-blocked.ts`.

**Payload shape, optimised for the screen.** The mobile view needs a company, a
card, a spend figure, three transactions and a count. Four round trips to
render one screen is four chances to be slow on mobile, so `getCompanyDashboard`
answers all of it in one response. The paginated transaction list stays a
separate operation, because the screen's `54 more items` link is a different
navigation.

Two decisions worth naming:

- **Money is an integer minor-unit value plus an ISO-4217 code** — `5 400 kr` is
  `{ minorUnits: 540000, currency: "SEK" }`. Never a float, never preformatted.
  Formatting is a locale decision that belongs to the client; a provider that
  sends `"5 400 kr"` has hard-coded a locale into the contract.
- **`remaining` is computed, not stored.** No column holds it. It is the limit
  minus settled spend, derived in the mapping layer, so it cannot drift from the
  transactions it summarises.

**Response tolerance, request strictness.** Consumers ignore unknown response
fields, so a provider adding one ships without asking. Providers reject unknown
request fields, because provider-first deploy ordering is achievable here. Every
enum carries an explicit `unknown` member, so adding an enum value is not a
silent break — `apps/web-b` tests both halves. `null` is never emitted; absent
means not applicable, and the linter enforces it.

#### API Structure

```text
packages/contracts-service-a/   the published contract — TypeBox schemas,
                                a ts-rest contract, an emitted OpenAPI
                                artifact. Owned by the provider team via
                                CODEOWNERS. Imports nothing from packages/db.
services/service-a/             the provider. routes -> mapping -> repositories,
                                with client identity and usage logging as
                                middleware.
packages/contract-tooling/      the gates: emit, lint, diff, dependency, pins.
apps/web-a, apps/web-b          consumers. Types come from the contract
                                package, never a generator.
services/service-b              a provider that is also a consumer.
```

`service-b` exists because today's provider is tomorrow's consumer. It pins
`contracts-service-a` exactly and is reviewed through the same CODEOWNERS path
an app is — ownership shifts, the mechanism does not.

**Consumers pin exact versions.** `"0.1.0"`, never `^0.1.0`. The friction is
deliberate: adopting a new contract version must be a reviewed PR, because that
PR is the record of which consumer is on which version. CI rejects a range.

**Every request carries a `client_id` derived from a credential**, logged with
the operation and the contract version. Not `User-Agent` — a `client_id` a
caller states about itself is a claim, whereas one the provider resolves from a
presented credential is evidence. With three consumers that reads as ceremony;
it is here because none of the history it accumulates can be added
retroactively.

#### Code Implementation

Five gates run per PR, in this fixed order, each blocking
([`docs/ci.md`](./docs/ci.md)):

| #   | Gate                                                       | Blocks                                                                                                            |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | **Emit** — build the OpenAPI artifact from the schemas     | An unrepresentable construct                                                                                      |
| 2   | **Lint** — `vacuum` against the house ruleset              | Typeless schemas, implicit `additionalProperties`, enums with no unknown member, deprecations with no sunset date |
| 3   | **Diff** — `oasdiff` against the last published artifact   | Any breaking change                                                                                               |
| 4   | **Dependency** — no contract package imports `packages/db` | A database-derived contract                                                                                       |
| 5   | **Pins** — every consumer pins exactly                     | A range specifier                                                                                                 |

Order is a governance decision, not a convenience: emit failing first means a
lint error is never reported against a document that could not be built.

All five [acceptance criteria](./.specs/01-bare-minimal-api-governance-poc.md)
are executable rather than narrated:

```bash
bun run pipeline:simulate                                  # the gates
bun scripts/acceptance/01-consumer-adds-field.ts           # additive passes
bun scripts/acceptance/02-removal-is-blocked.ts            # removal blocked
bun scripts/acceptance/03-db-derived-export-is-blocked.ts  # db-derived blocked
bun scripts/acceptance/04-usage-query.ts                   # who called what
bun scripts/acceptance/05-pin-bump-is-reviewable.ts        # pins are exact
```

Each one asserts the gates are **green before** it mutates anything. Without
that control, "CI blocked it" passes just as happily against gates that reject
everything — and that control caught two real bugs during development, both
invisible to the red half of the check.

**Deliberately not built:** a schema registry, Pact, generated SDKs, an API
review board. Each has a written trigger in
[`docs/governance.md`](./docs/governance.md), and none has fired. Tier 3 may
never be needed for a pure TypeScript stack — a pinned contract package plus
these gates covers what a registry would. Adopting it early costs coordination,
buys nothing, and makes the whole system look like bureaucracy, which poisons it
for when it is actually needed.
