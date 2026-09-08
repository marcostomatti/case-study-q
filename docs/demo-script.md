# Demo script

Thirty minutes, five beats. Every command here is real and exits non-zero when
its claim is false — nothing in this walkthrough is narrated over a slide.

## Before you start

Two binaries and Docker. See
[`../.plans/PREREQUISITES-01-bare-minimal-api-governance-poc.md`](../.plans/PREREQUISITES-01-bare-minimal-api-governance-poc.md).

```bash
bun install && vacuum version && oasdiff --version && docker compose version
```

---

## Beat 0 — the problem, in one screen (2 min)

Open `assets/mobile-view.png`. A company selector, an invoice-due banner, a
card, `5 400/10 000 kr` remaining, three transactions and `54 more items`.

The frontend team can describe every field on it. They cannot ship it, because
the contract does not exist and only the backend team may write one. That queue
is the problem — not backend capacity.

---

## Beat 1 — the stack, and the mock that does the unblocking (4 min)

```bash
bun run demo:up
```

Three things come up: Postgres, `service-a`, and **a Prism mock serving the
published contract**. The mock is the whole mechanism — it answers the contract
without a single handler behind it.

Show the real service answering:

```bash
curl -s -H 'Authorization: Bearer demo-web-a-token' \
  http://127.0.0.1:53000/companies/11111111-1111-4111-8111-111111111111/dashboard | jq
```

`540000` of `1000000` `SEK`, three transactions, `furtherTransactionCount: 54`.
That is the screen, in integer minor units with a currency code — never a float,
never a preformatted string.

Now the same operation against the mock, which has no database and no handler:

```bash
curl -s -H 'Authorization: Bearer demo-web-a-token' \
  http://127.0.0.1:54010/companies/11111111-1111-4111-8111-111111111111/dashboard | jq
```

Same shape. That is what a consumer builds against on day one.

Worth showing: the mock enforces the contract's own security scheme.

```bash
curl -s -i http://127.0.0.1:54010/companies | head -3
```

`401`, from the document — not from code anybody wrote.

---

## Beat 2 — a consumer proposes a field, and CI agrees (6 min)

The frontend needs an organisation number on the company selector. They open a
PR **against the contract package they do not own**.

```bash
bun scripts/acceptance/01-consumer-adds-field.ts
```

Read the output in order. It proves the gates are green *before* the change,
adds the field, shows every gate accepting it — additive is not breaking — and
confirms the emitted document actually carries the new field.

That last check matters more than it looks. Without it, "the gates passed" is
also true when the mutation never reached the emit at all.

The provider approves via CODEOWNERS, the version bumps, and the mock serves
the new field the moment it merges. **The frontend is unblocked at merge, not
at deploy.**

---

## Beat 3 — the gates, and what they refuse (8 min)

```bash
bun run pipeline:simulate
```

Emit → lint → diff → dependency, in that fixed order, over every contract
package, then the pin gate over every consumer. The order is a governance
decision, not a convenience: emit failing first means a lint error is never
reported against a document that could not be built.

Then show it refusing. Three separate rules, three separate scripts:

```bash
bun scripts/acceptance/02-removal-is-blocked.ts
```

Removes `artUrl` from the published card. `oasdiff` names both operations it
breaks and the exact property path. **Blocked.**

```bash
bun scripts/acceptance/03-db-derived-export-is-blocked.ts
```

Adds the module a well-meaning developer writes — a contract schema generated
straight off the Drizzle table. **Blocked**, naming the file and the import.
This is spec §2.1: deriving the contract from the table publishes your database
to every consumer and makes every migration a potential contract break.

```bash
bun scripts/acceptance/05-pin-bump-is-reviewable.ts
```

Relaxes the pin to `^0.1.0`. **Blocked** — a range lets an install move a
consumer onto a contract nobody reviewed. Then it bumps to an exact `0.2.0` and
shows the adoption diff is one line in one manifest, on a CODEOWNERS path.

Every one of these asserts green *first*. A script that only checks the red
would pass just as happily against gates that reject everything.

---

## Beat 4 — who is actually calling you (5 min)

```bash
bun scripts/acceptance/04-usage-query.ts
```

Three consumers call, and one SQL statement over `api_usage` answers which
`client_id` called which operation at which contract version over 30 days.

The identity is **derived from a credential the provider resolves**, never a
header the caller states about itself. `User-Agent` is a claim; this is
evidence.

This is the one thing in the whole design that cannot be added retroactively.
The affected-consumer list a major version needs (§6.2) and the "is anyone
still using this field" check that gates retirement (§6.4) both read rows that
only exist if identity was recorded from the very first request.

---

## Beat 5 — what was deliberately not built (5 min)

Open [`governance.md`](governance.md).

Tier 3 — a schema registry — **may never be needed** for a pure TypeScript
stack. A pinned npm contract package plus these CI gates covers what a registry
would. Adopting it early costs coordination, buys nothing, and makes the whole
system look like bureaucracy, which poisons it for when it is actually needed.

Same for Pact, generated SDKs, and an API review board. Each has a written
trigger. None has fired.

Close on the tier table: what each gate blocks, and which of them needs a human
to agree.

---

## Teardown

```bash
docker compose -f docker/compose.yaml down -v
```

## If something goes wrong

| Symptom | Cause |
| --- | --- |
| `address already in use` | Something holds 55432 / 53000 / 54010. Override `POSTGRES_PORT`, `SERVICE_A_PORT`, `MOCK_SERVICE_A_PORT`. |
| `spawn vacuum ENOENT` | The gate binaries are not on PATH. See the prerequisites. |
| A container is "Up Less than a second" | It is crash-looping. `docker compose -f docker/compose.yaml logs <service>`. |
| An acceptance script leaves the tree dirty | It crashed mid-mutation. `git checkout -- .` restores it; each script restores in a `finally`. |
