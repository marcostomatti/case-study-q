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

Look [here](./PRESENTATION.md) for the presentation deliverable.

### Task 2: API Implementation

Run it: `bun install && bun run demo:up`, then follow
[`docs/demo-script.md`](./docs/demo-script.md).

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

| # | Gate | Blocks |
| - | ---- | ------ |
| 1 | **Emit** — build the OpenAPI artifact from the schemas | An unrepresentable construct |
| 2 | **Lint** — `vacuum` against the house ruleset | Typeless schemas, implicit `additionalProperties`, enums with no unknown member, deprecations with no sunset date |
| 3 | **Diff** — `oasdiff` against the last published artifact | Any breaking change |
| 4 | **Dependency** — no contract package imports `packages/db` | A database-derived contract |
| 5 | **Pins** — every consumer pins exactly | A range specifier |

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
