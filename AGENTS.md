## Workspace map

| Path                 | Package                  | What it is                                                                                                         |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `packages/*`         | `@marcos-corp/*`         |                                                                                                                    |
| `clients/web-*`      | `@marcos-corp/web-*`     |                                                                                                                    |
| `services/service-*` | `@marcos-corp/service-*` |                                                                                                                    |
| `tools/ralph`        | —                        | The agent task loop (`bun run ralph plan \| start \| usage` from the repo root). Plans/trackers live in `.plans/`. |

Each package keeps its own `AGENTS.md` with package-specific conventions —
read it before working inside that package. Both vendored packages are
**fork-style copies** of their template repos: no automated sync; a change
wanted in both places must be made in both repos.

## Shared tooling

- `eslint.base.mjs` + `sharedRules.mjs` at the root; each package (and the
  root) layers its own leaf `eslint.config.mjs` on top.
- `tsconfig.base.json` is the shared strict core; leaves specialize
  (DOM/react-jsx for ui/web, node-strict for service, root covers `tools/`).
- Root scripts: `lint:all`, `check-types:all`, `test:all` fan out to every
  package; bare `lint`/`check-types`/`test` cover root files + `tools/`.
- Runtime: bun-first (`packageManager` pinned). `@marcos-corp/web-*`'s test toolchain
  additionally needs Node 22 on PATH (`bun x` shebang handling).