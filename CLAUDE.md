Refer to @AGENTS.md for the umbrella map, shared tooling, plans/specs law,
security posture, and verification order.

Quick orientation:

- Bun-workspaces monorepo: `@marcos-corp/packages-*` (),
  `@marcos-corp/web-*` (clients and web apps), `@marcos-corp/service-*` (Express/MCP services). Ralph loop at `tools/ralph`, run from the repo root.
- Working inside a package? Read that package's `AGENTS.md` first — each has
  its own conventions (ui: variants-only styling + baseline-safe verification;
  service: isolated/live test seam + framework-vs-app split).
- `.plans/` and `.specs/` are untracked on purpose (unpatched security/privacy
  content). Never move their contents into tracked paths.
- Specs feed the loop: `bun run ralph plan --spec=.specs/<file>.md`, then
  `bun run ralph start --plan=.plans/PLAN-<stub>.md`.
