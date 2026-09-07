# TypeDoc setup — adding generated docs to a project

Follow this pattern when setting up TypeDoc in this repo, or in a library extracted from it.

---

## Files to create

### `typedoc.json`

For services (document all internal modules):

```json
{
  "entryPointStrategy": "expand",
  "entryPoints": ["src"],
  "out": ".docs/typedoc",
  "tsconfig": "tsconfig.docs.json",
  "excludePrivate": true,
  "excludeInternal": true,
  "name": "My Service Name",
  "readme": "README.md"
}
```

For packages (document the public API surface only):

```json
{
  "entryPoints": ["src/index.ts"],
  "out": ".docs/typedoc",
  "tsconfig": "tsconfig.docs.json",
  "excludePrivate": true,
  "excludeInternal": true,
  "name": "My Package Name",
  "readme": "README.md"
}
```

The difference: services use `"entryPointStrategy": "expand"` with a directory to document all
modules. Packages point to a single `src/index.ts` to document only the exported public API.

### `tsconfig.docs.json`

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "src/**/*.test.ts", "scripts"]
}
```

Always exclude test files — TypeDoc compiles them and fails on strict TS errors in test helpers.

### `package.json` script

```json
"docs:generate": "typedoc && bun scripts/export-openapi.ts"
```

For packages without an OpenAPI spec:

```json
"docs:generate": "typedoc"
```

---

## devDependencies to add

```json
"typedoc": "^0.28.17"
```

---

## Gitignore

Auto-generated docs go in `.docs/` (a dotfolder) — never in `docs/`.

The root `.gitignore` must contain a `.docs` entry so the output directory is
never committed — add it if it is missing.

`docs/` (manual ADRs, design notes) is intentionally **not** gitignored.
Never put auto-generated output in `docs/`.

If you create a new output location for generated docs, add it to `.gitignore` explicitly.

---

## Verifying the setup

```sh
bun docs:generate
```

Expected output:
- TypeDoc: `[info] html generated at ./.docs/typedoc` with 0 errors
- OpenAPI script (if present): `OpenAPI spec written to ./.docs/swagger/openapi.json`

TypeDoc will emit warnings for private classes referenced by exported symbols (e.g. a
singleton exported as `const foo = new FooClass()` where `FooClass` is not exported).
These are acceptable if `FooClass` is intentionally private.

---

## Known gotcha: `tsconfig.docs.json` must exclude tests

If TypeDoc's tsconfig includes test files, it will compile them and may fail on:
- Test-only imports that TypeDoc can't resolve
- Loose types in test utilities that don't pass `strict` mode

Always add `"src/**/*.test.ts"` to the `exclude` array in `tsconfig.docs.json`.
