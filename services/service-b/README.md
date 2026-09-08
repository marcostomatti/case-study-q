# `@marcos-corp/service-b`

The provider-as-consumer case. Spec §1 requires it so the design has to show
that **ownership shifts** — today's provider is tomorrow's consumer, and the
governance mechanism does not change when it does.

## Status: partially built

Read this before judging the package.

| | |
| --- | --- |
| **Built** | The consumer half: a typed client for `@marcos-corp/contracts-service-a`, pinned exactly, presenting its own credential, tolerating unknown response fields. |
| **Not built** | The provider half: `src/routes/` and a server. The due-invoice operation is declared in `@marcos-corp/contracts-service-b` and answered by nothing. |

So `service-b` is **a consumer in fact and a provider only on paper**. That is a
known gap, not an oversight — it is recorded in `progress.txt` and in the plan
tracker, and it is the largest unbuilt item in the proof of concept.

### What still holds despite the gap

The claim this package exists to support is about *governance*, not about
invoices, and that claim is fully demonstrated:

- It pins `@marcos-corp/contracts-service-a` at an exact version with no range
  specifier (spec §2.2). `bun scripts/acceptance/05-pin-bump-is-reviewable.ts`
  proves a range is rejected and that bumping the pin is a one-line diff on a
  CODEOWNERS-reviewed path.
- It presents its own credential, so `service-a` resolves `client_id`
  `service-b` and `api_usage` tells it apart from either app (spec §2.3).
  Visible in `bun scripts/acceptance/04-usage-query.ts`.
- It tolerates unknown response fields (spec §2.5). A provider consuming
  another provider has no more right to reject an additive change than an app
  does.
- Its client answers correctly against **both** the real `service-a` and the
  Prism mock — the same types, the same contract, one of them with no handler
  behind it. That is spec §6.1's "unblocked at merge, not at deploy" made
  literal.

None of that depends on `service-b` serving anything of its own.

### What the gap actually costs

A reviewer asking *"what does `service-b` serve?"* gets no answer today. The
invoice contract is published, linted, diffed and gated like any other — it is
simply unimplemented. The `Invoice due` banner in `assets/mobile-view.png` is
therefore the one element of the screen with no live endpoint behind it.

Closing it means `src/routes/` implementing the due-invoice operation over the
`invoices` table, plus a composition root mirroring
`services/service-a/src/main.ts`, plus an integration test. The pattern to copy
is `service-a` throughout.

## Contents

```text
src/clients/serviceAClient.ts   the typed client for service-a
src/index.ts                    the package barrel (side-effect free)
```

`src/index.ts` re-exports only; it starts nothing. When a server lands here it
belongs in a separate `src/main.ts`, for the reason `service-a` learned the hard
way: running a re-export barrel as a container entrypoint exits 0 immediately,
and under `restart: unless-stopped` that is an invisible crash loop.

## Conventions

Inherited from the repo root — see [`../../AGENTS.md`](../../AGENTS.md):

- Contract schemas stay TypeBox inside `packages/contracts-*`. Zod is the tool
  for anything internal to this service.
- Drizzle row shapes never reach a response; a mapping layer translates them.
- Money is integer minor units plus an ISO-4217 code.

## Commands

```bash
bun run --filter '@marcos-corp/service-b' lint
bun run --filter '@marcos-corp/service-b' check-types
bun run --filter '@marcos-corp/service-b' test
```

The suite needs no database and no running `service-a` — the client is tested
against a recording stub that asserts what the request carried, not only what
came back.
