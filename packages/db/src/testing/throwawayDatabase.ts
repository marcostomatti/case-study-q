/**
 * Stands a Postgres a suite can migrate, seed, read back and throw away.
 *
 * `packages/db` claims a set of figures — `5 400/10 000 kr`, 57 transactions —
 * and the suites that live beside the schema modules can only prove those
 * figures are *built*. Whether they survive `CREATE TABLE`, an `INSERT` and a
 * `SELECT` is a different claim, and the only thing that can settle it is a
 * real server. This module supplies one.
 *
 * ## Two routes, and why the order is that way round
 *
 *   1. **`TEST_DATABASE_URL`**, when set: an already-running server this
 *      module only ever connects to. It is the route CI and
 *      `docker/compose.yaml` take, and it wins when present so that a
 *      deliberately provisioned server is never quietly ignored in favour of
 *      one this module stood up itself.
 *   2. **A cluster of its own**, otherwise: `initdb` into a scratch directory,
 *      started on a **unix socket with TCP switched off**, so it is reachable
 *      by nothing but this process and cannot collide with a Postgres already
 *      holding port 5432. On the machine this was written, 5432 *is* held by
 *      an unrelated server with credentials this repo does not know, which is
 *      the concrete reason there is no `localhost:5432` default anywhere here.
 *
 * Either way the suite gets a **freshly created, uniquely named database** and
 * drops it afterwards. That is the load-bearing part of route 1: pointing
 * `TEST_DATABASE_URL` at a database and migrating into it directly would let a
 * mistyped variable rewrite somebody's development data.
 *
 * ## Neither route available
 *
 * `startThrowawayPostgres` throws, naming both routes and the `PG_BIN_DIR`
 * escape hatch. That is deliberate rather than a skip: the same argument
 * `@marcos-corp/contract-tooling` makes for shelling out to the real `vacuum`
 * applies here. A suite that silently passes without a database proves the
 * seed compiles, which is not the claim anyone is reading it for. Doing the
 * work in one `beforeAll` means an unprovisioned machine reports a single
 * pointed error rather than one lookalike failure per case.
 *
 * ## How other packages reach this
 *
 * As `@marcos-corp/db/testing`, a subpath of this package's `exports` map and
 * deliberately not a re-export from `src/index.ts` — the same argument
 * `src/seed.ts` makes at length. That file is the `schema` entry of
 * `drizzle.config.ts` and drizzle-kit executes it for its exports, so a module
 * that imports `pg` must not be reachable from it or `bun run db:generate`
 * grows a database driver on its path. Confirmed after adding the subpath:
 * `db:generate` still prints `No schema changes, nothing to migrate`.
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PoolConfig } from 'pg';

import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const execFileAsync = promisify(execFile);

/**
 * The migration folder `drizzle-kit generate` writes into, as an absolute
 * path resolved from this module rather than from `process.cwd()`. A suite
 * hands it straight to drizzle's `migrate`, and gets the same answer whether
 * it was started from the package or from the repository root.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Which of the two routes above produced the server. Reported, not chosen. */
export type PostgresSource = 'TEST_DATABASE_URL' | 'provisioned-cluster';

export interface ThrowawayDatabase {
  /** A drizzle handle on the new database, ready to migrate into. */
  readonly db: NodePgDatabase;
  /** The generated database name, so a failure message can name it. */
  readonly name: string;
  /** Closes the pool and drops the database. Safe to call twice. */
  drop(): Promise<void>;
}

export interface ThrowawayPostgres {
  readonly source: PostgresSource;
  /** A new, empty, uniquely named database on this server. */
  createDatabase(): Promise<ThrowawayDatabase>;
  /** Drops anything still standing and, on route 2, stops the cluster. */
  stop(): Promise<void>;
}

/** initdb + first connection are seconds, not milliseconds. */
export const THROWAWAY_POSTGRES_TIMEOUT_MS = 120_000;

/** Trust auth over a private socket, so this role never sees a password. */
const PROVISIONED_ROLE = 'postgres';

/**
 * Where a Postgres install keeps its binaries, in the two layouts that
 * matter: homebrew's `<root>/postgresql@<major>/bin` and Debian's
 * `<root>/<major>/bin`. Entries are filtered by whether the binaries are
 * actually there rather than by name, so neither layout is special-cased.
 */
const PG_BIN_ROOTS = ['/opt/homebrew/opt', '/usr/local/opt', '/usr/lib/postgresql'];

/**
 * A unix socket path is capped by `sun_path` — 104 bytes on macOS, 108 on
 * Linux — and the failure when it is exceeded names neither the socket nor
 * the limit. macOS's `TMPDIR` is a ~48-character private path, which leaves
 * enough room but not a lot, so the length is checked rather than assumed.
 */
const SUN_PATH_BUDGET = 100;
const SOCKET_FILE = '/.s.PGSQL.5432';
const SCRATCH_DIR_TEMPLATE = 'qred-pg-XXXXXX';

function scratchRoot(): string {
  const preferred = tmpdir();
  const socketPathLength = preferred.length + SCRATCH_DIR_TEMPLATE.length + SOCKET_FILE.length + 1;
  return socketPathLength <= SUN_PATH_BUDGET
    ? preferred
    : '/tmp';
}

function hasPostgresBinaries(binDir: string): boolean {
  return existsSync(join(binDir, 'initdb')) && existsSync(join(binDir, 'pg_ctl'));
}

/** Highest major version first, so a machine with two installs takes the newer. */
function majorVersion(binDir: string): number {
  const match = /(\d+)/.exec(binDir.replace(/\/bin$/, ''));
  return match
    ? Number(match[1])
    : 0;
}

function installedBinDirs(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .map((entry) => join(root, entry, 'bin'))
    .filter(hasPostgresBinaries)
    .sort((left, right) => majorVersion(right) - majorVersion(left));
}

/**
 * `$PG_BIN_DIR` first — it is the documented escape hatch for a runner whose
 * Postgres is somewhere this list does not guess — then `$PATH`, then the
 * usual install roots.
 */
function resolvePostgresBinDir(): string | null {
  const override = process.env.PG_BIN_DIR;
  const candidates = [
    ...(override
      ? [override]
      : []),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
    ...PG_BIN_ROOTS.flatMap(installedBinDirs),
  ];
  return candidates.find(hasPostgresBinaries) ?? null;
}

function unprovisionedMessage(): string {
  return 'throwaway Postgres cannot start: no server and no Postgres binaries.\n'
    + '  Either set TEST_DATABASE_URL to a server this suite may create a database on\n'
    + '  (the docker/compose.yaml stack and CI both provide one), or install Postgres\n'
    + '  so a private cluster can be stood up here. If it is installed somewhere\n'
    + `  unusual, point PG_BIN_DIR at the directory holding initdb and pg_ctl. Looked\n  in $PATH and in: ${PG_BIN_ROOTS.join(', ')}`;
}

/** Unique per run: two suites in the same second must not collide. */
function generateDatabaseName(): string {
  const stamp = Date.now().toString(36);
  const salt = Math.random()
    .toString(36)
    .slice(2, 10);
  return `qred_throwaway_${stamp}_${salt}`;
}

/**
 * The same server, addressed at a different database.
 *
 * Route 1 is handed a URL, so the database is swapped in its path; route 2
 * builds its config as fields and only the `database` changes.
 */
function configFor(maintenance: PoolConfig, database: string): PoolConfig {
  if (typeof maintenance.connectionString !== 'string') {
    return { ...maintenance, database };
  }
  const url = new URL(maintenance.connectionString);
  url.pathname = `/${database}`;
  return { ...maintenance, connectionString: url.toString() };
}

interface ProvisionedCluster {
  binDir: string;
  scratchDir: string;
}

/**
 * `initdb` into a scratch directory, then start it on a unix socket only.
 *
 * `listen_addresses` is emptied in `postgresql.conf` rather than passed
 * through `pg_ctl -o`: that option is handed to a shell by `pg_ctl`, so the
 * empty string has to survive a quoting round trip that the config file does
 * not have. `fsync = off` is free here — the whole cluster is discarded.
 */
async function provisionCluster(binDir: string): Promise<ProvisionedCluster> {
  const scratchDir = await mkdtemp(join(scratchRoot(), 'qred-pg-'));
  const dataDir = join(scratchDir, 'data');

  await execFileAsync(join(binDir, 'initdb'), [
    '--pgdata', dataDir,
    '--username', PROVISIONED_ROLE,
    '--auth', 'trust',
    '--encoding', 'UTF8',
    '--no-sync',
  ]);

  await appendFile(
    join(dataDir, 'postgresql.conf'),
    `\nlisten_addresses = ''\nunix_socket_directories = '${scratchDir}'\nfsync = off\n`,
  );

  await execFileAsync(join(binDir, 'pg_ctl'), [
    '--pgdata', dataDir,
    '--log', join(scratchDir, 'server.log'),
    '--wait',
    'start',
  ]);

  return { binDir, scratchDir };
}

async function stopCluster(cluster: ProvisionedCluster): Promise<void> {
  await execFileAsync(join(cluster.binDir, 'pg_ctl'), [
    '--pgdata', join(cluster.scratchDir, 'data'),
    '--mode', 'immediate',
    'stop',
  ]);
  await rm(cluster.scratchDir, { recursive: true, force: true });
}

/**
 * Resolves a server, preferring one that was deliberately provided.
 *
 * Returns the connection this module uses only to `CREATE DATABASE` and
 * `DROP DATABASE`; no suite ever reads or writes through it.
 */
async function resolveServer(): Promise<{
  source: PostgresSource;
  maintenance: PoolConfig;
  cluster: ProvisionedCluster | null;
}> {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    return { source: 'TEST_DATABASE_URL', maintenance: { connectionString: url }, cluster: null };
  }

  const binDir = resolvePostgresBinDir();
  if (!binDir) {
    throw new Error(unprovisionedMessage());
  }

  const cluster = await provisionCluster(binDir);
  return {
    source: 'provisioned-cluster',
    maintenance: { host: cluster.scratchDir, user: PROVISIONED_ROLE, database: 'postgres' },
    cluster,
  };
}

/**
 * Starts a Postgres and hands back a factory for throwaway databases on it.
 *
 * Call `stop()` in an `afterAll`. It drops every database this handle created
 * that is still standing, which is what keeps a failed run from leaking one
 * onto a shared server reached through `TEST_DATABASE_URL`.
 */
export async function startThrowawayPostgres(): Promise<ThrowawayPostgres> {
  const { source, maintenance, cluster } = await resolveServer();
  const admin = new Pool(maintenance);
  const live = new Map<string, () => Promise<void>>();

  const createDatabase = async (): Promise<ThrowawayDatabase> => {
    const name = generateDatabaseName();
    // The name is generated from `[a-z0-9_]` here and never supplied by a
    // caller, so quoting it is belt-and-braces rather than the only defence.
    await admin.query(`CREATE DATABASE "${name}"`);

    const pool = new Pool(configFor(maintenance, name));
    const drop = async (): Promise<void> => {
      if (!live.has(name)) {
        return;
      }
      live.delete(name);
      // The pool has to be closed first: Postgres refuses to drop a database
      // that still has a session attached, and the refusal names the session
      // rather than the pool nobody remembered to end.
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    };

    live.set(name, drop);
    return { db: drizzle({ client: pool }), name, drop };
  };

  const stop = async (): Promise<void> => {
    for (const drop of [...live.values()]) {
      await drop();
    }
    await admin.end();
    if (cluster) {
      await stopCluster(cluster);
    }
  };

  return { source, createDatabase, stop };
}
