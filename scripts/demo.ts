#!/usr/bin/env bun

/**
 * demo — bring the stack up, migrate, seed, and prove all three ports answer.
 *
 *   bun run demo:up
 *
 * Brings up Postgres, the Prism mock and `service-a`, applies the Drizzle
 * migrations, runs the seed that renders the mobile view's figures, and then
 * checks each surface rather than assuming a started container is a working
 * one. A container that starts and immediately crash-loops still satisfies
 * `docker compose up -d`.
 *
 * Tear down with:
 *
 *   docker compose -f docker/compose.yaml down -v
 */

import path from 'node:path';

import { REPO_ROOT } from './contractPackages';

const COMPOSE_FILE = path.join(REPO_ROOT, 'docker', 'compose.yaml');

const SERVICE_A_PORT = process.env.SERVICE_A_PORT ?? '53000';
const MOCK_PORT = process.env.MOCK_SERVICE_A_PORT ?? '54010';
const POSTGRES_PORT = process.env.POSTGRES_PORT ?? '55432';

const POSTGRES_USER = process.env.POSTGRES_USER ?? 'governance';
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'governance';
const POSTGRES_DB = process.env.POSTGRES_DB ?? 'governance';

/** Where anything on the host reaches the seeded database. */
export const HOST_DATABASE_URL =
  `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}`;

/** How long to wait for a surface to answer before calling the demo broken. */
const READY_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1_000;

function run(command: string[], env: Record<string, string> = {}): number {
  console.log(`\n$ ${command.join(' ')}`);
  const child = Bun.spawnSync(command, {
    cwd: REPO_ROOT,
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, ...env },
  });
  return child.exitCode ?? 1;
}

/** Polls a URL until it answers anything at all, or the timeout expires. */
async function waitForHttp(label: string, url: string): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      // Any status is readiness. A 404 from Prism on `/` still proves the mock
      // is listening and parsed the contract; only a connection refusal means
      // it is not up.
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      console.log(`  ready  ${label} — ${url}`);
      return true;
    } catch {
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }

  console.error(`  FAILED ${label} did not answer within ${READY_TIMEOUT_MS / 1000}s — ${url}`);
  return false;
}

async function main(): Promise<number> {
  console.log('Demo stack — Postgres, the Prism mock, and service-a');

  if (run(['docker', 'compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait']) !== 0) {
    console.error('\nFAILED — compose could not bring the stack up.');
    return 1;
  }

  console.log('\nApplying migrations and seeding the mobile view figures.');

  if (run(['bun', 'run', '--filter', '@marcos-corp/db', 'db:migrate'], { DATABASE_URL: HOST_DATABASE_URL }) !== 0) {
    console.error('\nFAILED — migrations did not apply.');
    return 1;
  }

  if (run(['bun', 'run', '--filter', '@marcos-corp/db', 'db:seed'], { DATABASE_URL: HOST_DATABASE_URL }) !== 0) {
    console.error('\nFAILED — the seed did not run.');
    return 1;
  }

  console.log('\nChecking every surface actually answers.');

  const mockUrl = `http://127.0.0.1:${MOCK_PORT}/companies`;
  const serviceUrl = `http://127.0.0.1:${SERVICE_A_PORT}/companies`;

  const mockReady = await waitForHttp('mock-service-a', mockUrl);
  const serviceReady = await waitForHttp('service-a    ', serviceUrl);

  if (!mockReady || !serviceReady) {
    console.error('\nFAILED — a container started but its surface never answered.');
    console.error('Read its output with: docker compose -f docker/compose.yaml logs');
    return 1;
  }

  console.log(`
READY

  service-a (real)     http://127.0.0.1:${SERVICE_A_PORT}
  mock-service-a       http://127.0.0.1:${MOCK_PORT}
  postgres             ${HOST_DATABASE_URL}

The mock serves the published contract, so a consumer can build against a
contract version before any handler for it exists. That is spec §6.1.

Next:
  bun run pipeline:simulate                       the spec §8 gates
  bun scripts/acceptance/04-usage-query.ts        who called what, at which version
  docker compose -f docker/compose.yaml down -v   tear it down
`);

  return 0;
}

process.exitCode = await main();
