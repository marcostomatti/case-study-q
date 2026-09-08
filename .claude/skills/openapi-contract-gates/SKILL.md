---
name: openapi-contract-gates
description: Use when building or debugging an OpenAPI contract package in TypeScript — TypeBox or Zod schemas behind ts-rest, an emitted document, and CI gates over it with vacuum and oasdiff. Covers the traps that make a gate silently stop checking anything.
---

# Building OpenAPI contract gates that actually fire

Every trap here was measured, and every one of them leaves a gate **green
while checking nothing**. That is the failure mode this whole file is about:
a contract gate that has quietly stopped reading is worse than no gate,
because it reads as coverage.

---

## ts-rest

**Do not call `c.router()` when the schemas are TypeBox.** Under zod 4 it
destroys the inferred types — they collapse to something that still compiles
and no longer describes the contract. Declare the object and use
`satisfies AppRouter` instead.

**`@ts-rest/core`'s optional zod peer is a lie at runtime.** The ESM build
imports zod unconditionally. A package declaring only `@ts-rest/core` resolves
at type-check time and throws on first import. Declare zod even when nothing
in the package uses it.

**`@ts-rest/express` validates NOTHING when the schemas are TypeBox.** Its
validation path is zod-specific. A TypeBox contract mounted through it parses
no request body and rejects no unknown field — the router is a router, not a
gate. Request checking has to be written explicitly, and a test asserting a
malformed body is refused is what stops the omission being invisible.

**Do not reach for `@ts-rest/open-api`.** It silently drops every TypeBox
schema, emitting a document whose operations have no request or response
shapes at all. The emitted file still parses, still lints, and describes
nothing. Emit the document yourself from the contract.

## TypeBox

**`Type.Union([Type.Literal(...)])` emits no `enum` keyword.** It emits
`anyOf` with `const` members. Any lint rule keyed on `enum` — "every enum
carries an unknown member", say — never sees it, so the rule passes on a
schema it was written to catch. Use `Type.Unsafe<T>({ type: 'string', enum: [...] })`
when the emitted JSON Schema must carry `enum`.

**TypeBox cannot validate the `Type.Unsafe` enum idiom**, in either spelling.
`Type.Unsafe` is a type-level assertion with no runtime checker attached, so
`Value.Check` passes anything. If you need runtime validation of that member,
it has to come from somewhere else — the emitted JSON Schema through ajv, for
instance.

**`Type.Unsafe<T>`'s type parameter is invisible to every runtime assertion.**
A test asserting the schema "is" `T` is asserting nothing. Assert the emitted
JSON instead, through `JSON.parse(JSON.stringify(schema))` — the object itself
carries TypeBox symbols that make a naive deep-equal misleading.

## vacuum

**vacuum is Spectral-*ruleset* compatible, not Spectral-*function*
compatible.** A ruleset using custom JS functions loads and then quietly
skips those rules. Only the built-in function set is portable.

**`vacuum lint` has no JSON output; `vacuum spectral-report` does** — and it
has THREE outcomes, not two: clean, findings, and failed-to-parse. Conflating
the third with either of the others is how a gate reports "no violations" for
a document it never read.

**vacuum resolves `$ref` before running a rule.** A rule written to inspect a
reference sees the resolved target instead, so rules about referencing
structure need a different approach than rules about shape.

**A small emitted document makes "the rule matched nothing" a live risk.**
Every house rule needs a fixture that violates *that rule and no other*, and
the fixtures need a clean base to sit against. Without the pairing, a rule
that silently stops matching passes everything.

## oasdiff

**Exit 2 from a gate binary has two causes** — a real finding and a failure to
run — and conflating them hides a dead gate behind a green pipeline. Branch on
the exit code explicitly and treat "could not run" as a distinct outcome from
"ran and found nothing".

**The FIRST published baseline makes the diff gate pass vacuously.** With
nothing to compare against, every change is non-breaking. Invert it to read
it: doctor the baseline, confirm the gate reddens, restore.

**A committed OpenAPI artifact is read by no lint gate.** It is JSON that
nothing type-checks. Pair it with a test asserting it stays byte-identical to
a fresh emit, or it drifts from the schemas and the diff gate starts comparing
against fiction.

## Installing the binaries in CI

**vacuum publishes `linux_x86_64`; oasdiff publishes `linux_amd64`.** Guessing
one naming for both 404s half the installs, and a 404 at install time surfaces
much later as a `spawn ENOENT` deep inside a suite, which reads as a test
failure rather than as setup.

**Pin both versions.** vacuum tightens rules between releases, so an unpinned
install makes the lint gate change its mind between runs of an unchanged tree.
That reads as flakiness rather than as the upgrade it is. A workstation with a
newer binary than CI reports violations CI never sees.

## Mutation-testing a contract gate

**Run the emit in a separate process.** Bun (and Node) cache modules by
resolved path, and a cache-busting query string on the emit entrypoint does
**not** reach the schema modules it imports. An in-process re-import after
mutating a schema returns the original, so every mutation reads as a no-op.
Measured: gates stayed green through a field removal that oasdiff calls
breaking, and the only visible symptom was the mutation "not being breaking".

**Assert the mutation reached the document.** After a mutation that is
expected to pass, check the emitted bytes actually contain the change.
Otherwise "the gates passed" is equally true when the mutation never applied.

**Every refusal check needs a positive control in the same run.** Assert the
gates are green *before* mutating. A script that only checks the red passes
just as happily against gates that reject everything — including gates broken
badly enough to fail on an empty document.
