---
name: bun-workspace-traps
description: Use when adding a package to a bun-workspaces monorepo, wiring its leaf lint/type/test config, or debugging why a root gate passes while a leaf is broken. Covers the isolated linker, per-leaf gate scope, and fan-out output that reads green while checking nothing.
---

# bun workspace traps

Each of these produces a **green gate over unchecked code**. That is the
shared shape: none of them fails loudly.

---

## The isolated linker

**bun does not hoist a leaf's runtime dependencies to the root.** A script at
the repo root importing `pg` fails with `Cannot find package` even though three
leaves depend on it. Root-level scripts need their own declarations.

**Tooling devDependencies are the exception** — eslint, typescript, vitest and
friends live at the root and resolve into every leaf, so a leaf must NOT
re-declare them. Doing so is version drift for no gain. Only a leaf's own
*runtime* dependencies belong in its manifest.

**bun does not symlink a workspace package into `node_modules` until something
depends on it.** A newly created package is invisible to imports until a
consumer declares it, and the error at that point names the package rather
than the missing dependency edge.

**A dependency-free leaf gets no `<pkg>/node_modules` at all.** Absence of that
directory is not evidence anything is wrong.

**`bun install` printing "no changes" still registers a new workspace
package.** The reassuring message does not mean it did nothing.

**`bun x` resolves per directory.** At a workspace root it may resolve nothing
and fetch registry latest instead, which is a different version than the leaf
would use.

## Fan-out gates read green too easily

**`bun run --filter '<scope>/*' <script>` DOES propagate a leaf failure** — the
exit code is trustworthy. What is not trustworthy is a filter that matches
**zero packages**: it exits 0 having run nothing. A stale scope in a
`lint:all` script is a gate that has silently stopped existing.

Read the package names in the output, not just the exit code.

**A leaf whose script is a placeholder `echo` also exits 0.** A green
`test:all` line says nothing about whether that package has tests.

**The root lint and a leaf lint are different gates.** A root
`eslint.config.mjs` that ignores `packages/**`, `apps/**` or `services/**`
means `bun run lint` never reads those files — they are linted only by their
own leaf config, through the fan-out. `bun run lint` exiting 0 while
`bun run lint:all` fails is the normal shape of this, not a contradiction.

## What each leaf gate actually reads

Measured, not assumed — and each gap is a directory nothing checks:

- **`*.test.ts` is linted but never type-checked**, when the leaf tsconfig
  excludes it. Use `*.test-d.ts` under `src/` for anything that must be
  type-checked; those ARE read.
- **A leaf's `scripts/` directory is linted but not type-checked** until the
  tsconfig `include` says so, and it is outside vitest's `include` too — so a
  suite under `scripts/` is collected by nothing.
- **No lint gate reads YAML or extensionless files.** Only a byte-level gate
  covers those.
- **A `drizzle.config.ts` at a leaf root IS read** by both leaf gates.

Adding `scripts/` to a leaf costs three config lines — tsconfig `include`,
eslint, vitest `include` — and every one of the three is silent about being
missing.

## Process entrypoints

**A side-effect-free re-export barrel is not a process entrypoint.** Running
`src/index.ts` in a container when that file only re-exports exits 0
immediately. Under `restart: unless-stopped` that becomes an invisible crash
loop: the container reports "Up Less than a second" forever and logs nothing,
and `docker compose up -d --wait` still reports success.

Give a service a separate `main.ts` that actually starts something, and have
the demo script check the surface answers rather than trusting that a started
container is a working one.

## Miscellaneous, each measured

- **The `packageManager` pin is not enforced by bun.** A different local
  version runs happily and can resolve differently than CI.
- **`drizzle-kit generate` exits 0 when it crashes on an interactive prompt.**
  Check that the migration file appeared, not the exit code.
- **`pg` reports a refused connection as an `AggregateError` with an EMPTY
  message.** The reason is only on `error.cause`, so a naive
  `error.message` handler prints nothing at all.
- **`--passWithNoTests` is temporary debt, not a convention.** A package
  created before its first suite needs it; drop it in the same change that
  adds the suite, or the package's green line is permanent and meaningless.
