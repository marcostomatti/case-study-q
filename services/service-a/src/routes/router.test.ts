/**
 * Runtime suite for `router.ts`, and the one claim no type can make.
 *
 * `initServer().router(contract, ...)` already requires an entry per operation
 * and refuses a key the contract does not declare, so the *shape* of the
 * mapping is a `bun run check-types` matter and is not re-asserted here. What
 * `tsc` cannot see is whether the implementation mounted under `activateCard`
 * is the one that calls `recordOperation(req, 'activateCard')` — that id is a
 * string each route states about itself, and getting it wrong fails nothing.
 * It quietly attributes one operation's traffic to another, and every question
 * spec section 2.3's `api_usage` exists to answer (the affected-consumer list
 * in spec section 6.2, the retirement notice in spec section 6.4) then gets a
 * confident wrong answer.
 *
 * So every case here drives a real handler and reads the row the real usage
 * logger wrote, asserting the recorded operation is the key the route is
 * mounted under.
 *
 * ## Why none of this needs a database
 *
 * Each operation is driven with input the contract itself refuses — an unknown
 * query field, a blank path parameter — so every handler returns its `400`
 * before it reads anything. That is not a convenience: `recordOperation` runs
 * as the first statement of every route precisely so that a refused request
 * still produces an attributed row, and this is the suite that says so. The
 * database handle is a `Proxy` that throws on any access, so a route that ever
 * did reach one fails loudly rather than passing for a reason unrelated to the
 * claim.
 *
 * The identity is attached by running the real `clientIdentityMiddleware`,
 * because attaching one is deliberately not exported — a hand-built request
 * would be testing a shape this service never produces.
 */
import type { RouteDependencies } from './dependencies';
import type { RegisteredConsumer, UsageEvent } from '../index';
import type { ServiceDatabase } from '../repositories/database';
import type { RouteInput } from '../testing/routeInvocation';
import type { ErrorResponse } from '@marcos-corp/contracts-service-a';

import { contract } from '@marcos-corp/contracts-service-a';
import { describe, expect, it } from 'vitest';

import {
  buildConsumerRegistry,
  clientIdentityMiddleware,
  fingerprintCredential,
} from '../auth/clientIdentity';
import { usageLoggerMiddleware } from '../telemetry/usageLogger';
import {
  fakeRequest,
  flushMicrotasks,
  invokeRoute,
  RecordingResponse,
} from '../testing/routeInvocation';

import { buildServiceRouter } from './router';

/** The contract version this deployment says it was built from. */
const CONTRACT_VERSION = '0.1.0';

const WEB_B_CREDENTIAL = 'qc_live_2a6d0f83b41c9e7d5028af61c3b94e70';

const WEB_B: RegisteredConsumer = {
  clientId: 'web-b',
  owner: 'team-b',
  credentialSha256: fingerprintCredential(WEB_B_CREDENTIAL),
};

const REGISTRY = buildConsumerRegistry([WEB_B]);

/**
 * A database handle no case here may touch.
 *
 * Every case drives its route to a refusal that happens before any read, so a
 * plain `{}` cast would work — and would pass just as well if a route started
 * reading before validating, which is the ordering this suite exists to pin.
 */
const UNREACHABLE_DATABASE = new Proxy({}, {
  get(_target, property) {
    throw new Error(
      `no case in router.test.ts may reach the database, and one read '${String(property)}'`,
    );
  },
}) as ServiceDatabase;

const DEPENDENCIES: RouteDependencies = {
  db: UNREACHABLE_DATABASE,
  cardMapping: { artBaseUrl: 'https://cdn.example.com/assets' },
  now: () => new Date('2026-09-08T12:00:00.000Z'),
};

/** What a handler answered, plus the `api_usage` row the request produced. */
interface Driven {
  readonly status: number;
  readonly body: ErrorResponse;
  readonly rows: readonly UsageEvent[];
}

/**
 * Drives one operation through the same middleware order `server.ts` mounts,
 * and hands back both what the route answered and what the logger recorded.
 */
async function drive(operationId: string, input: RouteInput): Promise<Driven> {
  const router = buildServiceRouter(DEPENDENCIES) as unknown as Record<string, unknown>;
  const handler = router[operationId];
  if (handler === undefined) {
    throw new Error(`the router has no implementation mounted under '${operationId}'`);
  }

  const rows: UsageEvent[] = [];
  const req = fakeRequest({ authorization: `Bearer ${WEB_B_CREDENTIAL}` });
  const res = new RecordingResponse();

  clientIdentityMiddleware(REGISTRY)(req, res.asResponse(), () => {
    // The auth middleware ran and accepted; nothing else to do here.
  });
  usageLoggerMiddleware({
    contractVersion: CONTRACT_VERSION,
    sink: (event) => {
      rows.push(event);
    },
  })(req, res.asResponse(), () => {
    // Mounted, and the request continues to the router.
  });

  const answer = await invokeRoute<ErrorResponse>(handler, { ...input, req, res });

  res.finish(answer.status);
  await flushMicrotasks();

  return { status: answer.status, body: answer.body, rows };
}

/**
 * One refusal per operation, each reaching its `400` before any read.
 *
 * Every entry deliberately fails on the request rather than on the data, which
 * is what keeps this suite free of a database — and what makes the recorded
 * operation id the only thing each case is really about.
 */
const REFUSALS = [
  ['listCompanies', { query: { bogus: '1' } }],
  ['getCompanyDashboard', { params: { companyId: '' } }],
  ['listCompanyTransactions', { params: { companyId: '' }, query: {} }],
  ['activateCard', { params: { companyId: '', cardId: '' }, body: {} }],
] as const satisfies readonly (readonly [string, RouteInput])[];

describe('buildServiceRouter', () => {
  it('mounts exactly the operations the contract declares', () => {
    const router = buildServiceRouter(DEPENDENCIES);

    expect(Object.keys(router).sort()).toStrictEqual(Object.keys(contract).sort());
  });

  it('mounts a function per operation', () => {
    const router = buildServiceRouter(DEPENDENCIES) as unknown as Record<string, unknown>;

    for (const key of Object.keys(contract)) {
      expect(typeof router[key]).toBe('function');
    }
  });

  it('drives every operation the contract declares', () => {
    // Closure the other way: a refusal table that fell behind the contract
    // would leave a new operation's id unasserted, and every case below would
    // still pass.
    expect(REFUSALS.map(([operationId]) => operationId).sort())
      .toStrictEqual(Object.keys(contract).sort());
  });
});

describe.each(REFUSALS)('%s', (operationId, input) => {
  it('records itself under the key it is mounted under', async () => {
    const driven = await drive(operationId, input);

    expect(driven.rows).toHaveLength(1);
    expect(driven.rows[0]?.operationId).toBe(operationId);
  });

  it('refuses an invalid request with the contract\'s 400', async () => {
    const driven = await drive(operationId, input);

    expect(driven.status).toBe(400);
    expect(driven.body.code).toBe('validation_failed');
  });

  it('records the refusal, not only the success', async () => {
    // The row is written from the response's `finish`, so a route that named
    // itself after validating would leave this as `<unrouted>`.
    const driven = await drive(operationId, input);

    expect(driven.rows[0]?.responseStatusCode).toBe(400);
    expect(driven.rows[0]?.clientId).toBe(WEB_B.clientId);
    expect(driven.rows[0]?.contractVersion).toBe(CONTRACT_VERSION);
  });
});
