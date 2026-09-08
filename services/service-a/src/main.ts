#!/usr/bin/env bun

/**
 * The process entrypoint: what `docker/compose.yaml` runs.
 *
 * `src/index.ts` is deliberately a re-export barrel with no side effects, so
 * importing this package never requires an environment, a consumer registry or
 * a reachable Postgres. That leaves something to actually START the service,
 * and this is it. Running the barrel instead exits 0 immediately, which under
 * `restart: unless-stopped` is an invisible crash loop — the container reports
 * "Up Less than a second" forever and logs nothing.
 *
 * The two things `startService` will not invent are supplied here, because they
 * are properties of a deployment rather than of the code:
 *
 * - The consumer registry. Spec §6.3 makes issuing a `client_id` a
 *   registration with a named owner, so the demo's three consumers are written
 *   out with their owners rather than generated.
 * - Where card artwork is served from.
 *
 * The demo credentials below are not a secret and are not pretending to be one.
 * They exist so `scripts/demo.ts` and the acceptance scripts can present a
 * `client_id` and get a real `api_usage` row. A deployment reads them from a
 * secret store; this is a proof of concept whose whole database is a seed
 * script.
 */

import { createHash } from 'node:crypto';

import { buildConsumerRegistry, type RegisteredConsumer } from './auth/clientIdentity';
import { startService } from './server';

/**
 * Where the demo serves card artwork from: an ORIGIN, with no path.
 *
 * The seed's `artAssetKey` already carries its own `card-art/` prefix and
 * `resolveCardArtUrl` just joins the two, so a base ending in `/card-art`
 * produces `.../card-art/card-art/...`. The gates never catch this — the URL
 * is still a valid `format: uri` string — so the doubling only shows up in a
 * rendered payload.
 */
const CARD_ART_BASE_URL = process.env.CARD_ART_BASE_URL ?? 'https://cdn.example.invalid';

/**
 * The bearer tokens the demo's three consumers present.
 *
 * Each consumer gets its OWN credential rather than sharing one, because the
 * point of spec §2.3 is telling them apart in `api_usage`. One shared token
 * would make every usage row say the same thing.
 */
export const DEMO_CREDENTIALS = {
  'web-a': 'demo-web-a-token',
  'web-b': 'demo-web-b-token',
  'service-b': 'demo-service-b-token',
} as const;

/** The registry `service-a` answers, with a named owner per spec §6.3. */
export const DEMO_CONSUMERS: readonly RegisteredConsumer[] = [
  { clientId: 'web-a', owner: 'team-a', credentialSha256: sha256(DEMO_CREDENTIALS['web-a']) },
  { clientId: 'web-b', owner: 'team-b', credentialSha256: sha256(DEMO_CREDENTIALS['web-b']) },
  { clientId: 'service-b', owner: 'team-b', credentialSha256: sha256(DEMO_CREDENTIALS['service-b']) },
];

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function main(): Promise<void> {
  // A container must bind every interface; the default loopback bind would make
  // the published port answer nothing from outside the container.
  const host = process.env.BIND_HOST ?? '0.0.0.0';

  const running = await startService({
    consumers: DEMO_CONSUMERS,
    cardMapping: { artBaseUrl: CARD_ART_BASE_URL },
    host,
  });

  console.log(`[service-a] listening on ${running.url}`);
  console.log(`[service-a] registered consumers: ${DEMO_CONSUMERS.map((c) => c.clientId).join(', ')}`);

  const shutdown = (signal: string): void => {
    console.log(`[service-a] ${signal} — closing`);
    void running.close().then(() => process.exit(0));
  };

  // Without these a `docker compose down` waits the full stop timeout and then
  // kills the process, so in-flight requests are dropped rather than drained.
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// `buildConsumerRegistry` validates the registry the same way `createServiceApp`
// will. Calling it here turns a malformed registry into a readable message at
// startup rather than an opaque throw from inside the app factory.
buildConsumerRegistry(DEMO_CONSUMERS);

await main();
