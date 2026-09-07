---
name: api
description: >
  Use when designing or modifying an HTTP endpoint or its client-side
  consumption in this service — covers Zod validation at the route boundary,
  response envelope shape, RESTful naming, auth/security requirements, and
  pagination.
tags: [api, rest, zod, openapi, express, jwt, pagination]
---

> Scope: file paths in this document are relative to `packages/service/` (the `@marcos-corp/service` package), except `.claude/`, `.plans/`, `.specs/`, and `tools/`, which live at the umbrella repo root.

# API Skill

This skill defines how to build and consume APIs in this service.

---

## Developing an API

- Validate all external input (request bodies, query params, headers) at the route/middleware boundary with Zod.
- Share common field schemas (e.g., `emailSchema`, `uuidSchema`) from a project-level shared file.
- Document API routes with TSDoc comments and keep OpenAPI specs in sync (see [`skills/documentation`](../documentation/SKILL.md)).
- Keep response schemas consistent: `{ success: boolean, data?: T, error?: string }`.
- Use RESTful naming and appropriate HTTP status codes.
- Apply security measures: authentication, authorization, input sanitization, rate limiting, CORS allowlist, HTTP security headers.
- Favor JWTs/auth tokens over server-side sessions for horizontal scalability.
- Use pagination for list routes.

---

## Consuming an API

- Handle responses and errors gracefully — never let unhandled rejections crash the app.
- Use auto-generated types from OpenAPI specs for type safety.
- Keep API consumption logic modular (separate fetching, state management, UI rendering).
- Do not implement caching without team alignment on architecture and performance goals.

---

## Measured zod-4 refusal shapes at this boundary

`parseBody` / `parseQuery` answer a `ValidationError` whose details name a
field path and never a submitted value. Which CODE each fault gets is not
guessable, and a refusal table that assumes one code per member writes rows
that pin nothing. All measured through the SERVICE (not the schema):

| Submitted | Code | Field |
| --- | --- | --- |
| `.positive()` given 0 or a negative | `too_small` | the member |
| `.max(N)` exceeded | `too_big` | the member |
| `.int()` given a fraction | `invalid_type` (fires BEFORE `.positive()`) | the member |
| array ELEMENT wrong | `invalid_type` | dotted `<member>.<index>` |
| whole list wrong-typed | `invalid_type` | the bare member |
| any number of undeclared keys | ONE `unrecognized_keys` | `body` |
| optional-but-not-nullable given `null` | `invalid_type` | the member |
| `z.enum(T)` MISSING, wrong, or explicit `null` | `invalid_value` | the member |
| NO body at all (`express.json` leaves it undefined) | `invalid_type` | `body` |
| `{}` where a member is required | `invalid_type` | the member |

Query half (`paginationQuerySchema`): an over-cap `perPage` is `too_big`, a
zero is `too_small`, a NON-NUMERIC `perPage` and a FRACTIONAL `page` are
both `invalid_type` (coercion fails before any bound is read, so a fraction
is NOT `too_small`), and an undeclared parameter answers ONE
`unrecognized_keys` at field `query` — the root, not the parameter.

Consequences for a refusal table, each a separate claim:

- A zero row and a fraction row are different (a schema keeping `.int()`
  and dropping `.positive()` reddens only the first).
- An entry row and a whole-list row are different.
- On an ENUM, a clear-with-null row and a bad-value row are the SAME claim,
  where on a nullable number they are separate.
- Every `unrecognized_keys` row is indistinguishable from every other at
  the detail level, so what makes such a row worth having is the KEY it
  submits, not the detail it expects.
- A body that BOTH omits a required member and carries an undeclared one
  answers TWO details, missing member first — the likeliest real mistake (a
  misspelt member name), and the shape a one-detail-per-row table gets
  wrong. Read the whole detail LIST, never its first entry.

`.strict()` survives `.extend()`, so a list route wanting a filter beside
the window should extend `paginationQuerySchema` rather than respell it —
but the inheritance is then what a case has to PROVE, since dropping
`.max(...)` or `.strict()` upstream is invisible everywhere else.

**Probe a new schema rather than deriving it**: call the SERVICE over a
`{} as never` store. The parse runs before any store method, so the
`TypeError: store.X is not a function` that follows an ACCEPTED body is
itself the positive control saying the body got through.

## Gotchas

- **`z.custom<T>()` without a check function is a no-op validator**: It accepts everything, including `undefined`. Always pass a runtime predicate: `z.custom<Fn>((val) => typeof val === 'function')`. The generic type parameter only influences TypeScript inference — it has no runtime effect.
