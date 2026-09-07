# Prerequisites

Non-automatable setup for `.plans/PLAN-01-bare-minimal-api-governance-poc.md`.
`bun install` is not listed here — it is already required of every contributor.

## Services

- [ ] Docker Desktop running. `docker compose version` must succeed; the plan
      brings up Postgres, a Prism mock and `service-a` from `docker/compose.yaml`.
- [ ] Ports 5432, 4010 and 3000 free on the loopback interface, or exported
      overrides set before `bun run demo:up`.

## Binaries

Both are single static Go binaries and both are installed in CI by the
`contracts` job. They must also be on PATH locally for `bun run pipeline:simulate`.

- [ ] `vacuum` on PATH — `vacuum version` must succeed.
- [ ] `oasdiff` on PATH — `oasdiff --version` must succeed.

Pin the same versions locally that `.github/workflows/ci.yml` installs. A local
`vacuum` newer than CI's reports rule violations CI does not, which reads as a
flaky gate.

## Postgres, for `bun run test`

`packages/db` carries an integration suite that migrates, seeds and reads the
mobile view's figures back out of a real server, so `bun run test` there — and
therefore `bun run test:all` — needs one. Either route satisfies it:

- [ ] `initdb` and `pg_ctl` reachable, from which the suite stands up a private
      cluster on a unix socket and throws it away afterwards. `$PATH`,
      `/opt/homebrew/opt/postgresql@*`, `/usr/local/opt/postgresql@*` and
      `/usr/lib/postgresql/*` are searched; `PG_BIN_DIR` reaches anywhere else.
- [ ] `TEST_DATABASE_URL` set to a server the suite may create a database on,
      which is the route CI and `docker/compose.yaml` take. It takes precedence
      over the cluster above.

Neither available is one pointed error and skipped cases, never a green run.

## Environment variables

Local-only defaults are committed in `docker/compose.yaml`. Override only if a
port or credential collides.

- `DATABASE_URL` — Postgres connection string used by `packages/db` migrations,
  the seed, and `service-a`.
- `SERVICE_A_PORT`, `MOCK_SERVICE_A_PORT`, `POSTGRES_PORT` — override the
  defaults above when a port is taken.
- `TEST_DATABASE_URL` — a Postgres `packages/db`'s integration suite may create
  and drop a uniquely named throwaway database on. It is never migrated or
  seeded into directly, so it is safe to point at a development server.
- `PG_BIN_DIR` — the directory holding `initdb` and `pg_ctl`, when Postgres is
  installed somewhere the search above does not reach.

Docker Compose gives shell environment precedence over `--env-file`. A variable
exported in the demo shell silently overrides the committed default; confirm the
effective values with `docker compose -f docker/compose.yaml config` before
blaming the file.

## GitHub

- [ ] Replace the handle placeholders in `.github/CODEOWNERS` with real GitHub
      users or teams. CODEOWNERS silently matches nothing when a handle does not
      resolve, so the review requirement that spec §3 depends on would be absent
      with no error shown.
- [ ] Enable branch protection on `main` requiring CODEOWNERS review, so the
      provider-approval step in the spec §6.1 workflow is enforced rather than
      conventional.

## Not required

- No self-hosted runner. This repository is public and must stay that way for
  review; every workflow targets GitHub-hosted `ubuntu-latest`.
- No npm registry credentials. Contract packages are workspace-resolved and
  "publishing" means committing a versioned OpenAPI baseline under
  `openapi/published/`.
