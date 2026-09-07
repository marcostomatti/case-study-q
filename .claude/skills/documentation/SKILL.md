---
name: documentation
description: >
  Use when adding or updating TSDoc comments, wiring TypeDoc into the
  service, documenting an Express route with OpenAPI/Swagger, or
  deciding whether a doc belongs in the gitignored `.docs/` output or the
  tracked `docs/` tree.
tags: [tsdoc, typedoc, openapi, swagger, express, mcp, react]
---

> Scope: file paths in this document are relative to the **service package the task is working in** (`services/service-*`), except `.claude/`, `.plans/`, `.specs/`, and `tools/`, which live at the repo root. This rule was written for a single `packages/service` package in another repository; treat every `packages/service/` path as `services/<the service you are editing>/`.

# Documentation Skill

This skill defines how to document code in this repo.
Two kinds of documentation are maintained:

| Kind | Tool | Output | When to generate |
| --- | --- | --- | --- |
| **Code (TypeDoc)** | `typedoc` | typedoc's default `out`, which resolves to the TRACKED `docs/` tree | `bun run docs:generate` |
| **API (Swagger)** | `@asteasolutions/zod-to-openapi` + `swagger-ui-express` | `.docs/swagger/openapi.json` + served behind `ctx.requireAuth` at `GET /docs/` | `bun run docs:openapi` |

> Both rows are INSTALLED in `@marcos-corp/service` — the OpenAPI half is no longer a
> convention to adopt on some later day, and [`rules/openapi.md`](rules/openapi.md)
> records what is there rather than a setup to perform. The two scripts are
> SIBLINGS sharing no output tree, which is worth stating because the pair of
> names suggests they do: `docs:openapi` writes the gitignored `.docs/swagger/`,
> while `docs:generate` is a bare `typedoc` carrying no `typedoc.json` and no
> `typedocOptions` key in either `package.json` or `tsconfig.json` — all three
> measured absent — so it takes typedoc's own default `out`, the TRACKED `docs/`
> tree beside it, with `cleanOutputDir` defaulting true. Running it therefore
> DELETES that tree before writing (measured once at typedoc 0.28.20: 14 tracked
> files removed, at exit 0, for a site documenting nothing).

Manual documentation (ADRs, design notes) lives in `docs/` and is never gitignored.
Auto-generated outputs go in `.docs/` (dotfolder) and are always gitignored.

---

## Rules index

| Rule file | When to use |
| --- | --- |
| [`rules/tsdoc.md`](rules/tsdoc.md) | Writing TSDoc comments on any TypeScript symbol |
| [`rules/openapi.md`](rules/openapi.md) | Documenting Express routes with OpenAPI/Swagger |
| [`rules/typedoc-setup.md`](rules/typedoc-setup.md) | Adding TypeDoc infra to the repo (or a project derived from it) |

---

## Workflow

1. **Determine kind before touching**: identify whether documentation is manual or auto-generated before editing. Manual docs live in `docs/`; auto-generated outputs live in `.docs/`.
2. **Manual docs**: include author and date in the file header. Never gitignore `docs/`.
3. **Auto-generated docs**: outputs go in `.docs/` (dotfolder). If adding a new documentation tool, add its output folder to `.gitignore`.
4. **Update in parallel**: update documentation before or in parallel with code changes — do not defer docs to a follow-up PR.

---

## Quick checklist

Before marking a documentation task done:

- [ ] Every exported function, class, and interface has a TSDoc block with `@param` and `@returns`.
- [ ] Every file has a `@packageDocumentation` comment (or is covered by a module-level JSDoc).
- [ ] Every Express router factory is documented with `@remarks` listing its HTTP endpoints.
- [ ] `typedoc.json`, `tsconfig.docs.json`, and a `docs:generate` script exist (see [`rules/typedoc-setup.md`](rules/typedoc-setup.md)).
- [ ] `src/openapi.ts` exists and every route is registered in it — `tests/invariants/openapi-coverage.test.ts` is the gate that says so, and a route added without a binding-table entry reddens it.
- [ ] `.docs/` is already gitignored twice over and needs no new entry: once at the repo root (`.gitignore`) and again at the package (`packages/service/.gitignore`), both files tracked. `git check-ignore -v packages/service/.docs/swagger/openapi.json` names the PACKAGE rule, the nearer file winning — take the source off that output rather than predicting it.
- [ ] `docs/` (manual ADRs) is **not** gitignored.
- [ ] `bun run docs:openapi` passes with 0 errors. Do NOT reach for `bun run docs:generate` as a verification: it exits 0 while WIPING the tracked `docs/` tree (see the note under the table above).

---

## Toolchain

```text
typedoc                          → HTML docs from TSDoc comments → the TRACKED docs/ tree
@asteasolutions/zod-to-openapi   → OpenAPI document from the Zod schemas the routes parse with
swagger-ui-express               → serves that document behind ctx.requireAuth at GET /docs/
scripts/export-openapi.ts        → writes .docs/swagger/openapi.json, via bun run docs:openapi
```

Dependencies go in `devDependencies` where the toolchain is only ever a test's or a generator's — `@seriousme/openapi-schema-validator`, `@types/swagger-ui-express` and `typedoc` are all there.
BOTH OpenAPI runtime halves sit in `dependencies` instead, and not just `swagger-ui-express`: `src/index.ts` imports `generateOpenApiDocument` at boot to build the document it serves, so `@asteasolutions/zod-to-openapi` is a runtime dependency too.
