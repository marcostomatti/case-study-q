/**
 * Runtime suite for `server.ts`, driven over real HTTP on an ephemeral
 * loopback port.
 *
 * Every other suite in this package stops at the edge of Express. The route
 * suites call a ts-rest implementation directly, `routes/errors.test.ts`
 * stands a hand-built application up to reach the two handlers, and
 * `routes/router.test.ts` runs the middleware in sequence by hand. What none
 * of them can say is whether the application this service actually serves
 * mounts those pieces in the order each module's header assumes — and that
 * order is the whole content of this file. So the cases below bind the real
 * `createServiceApp` output and speak to it with `fetch`.
 *
 * ## Why this needs no database
 *
 * Two reasons, and the second is the interesting one. Every request here is
 * either refused before a read (no credential, an unknown query field, a body
 * Express cannot parse) or deliberately driven into one — the database handle
 * is a `Proxy` that answers `insert` and throws on every other access, so a
 * route that reads is a `500` this suite can assert rather than a case that
 * passes for an unrelated reason.
 *
 * Answering `insert` rather than throwing on it is what removes a seam:
 * `createServiceApp` takes no usage-sink override, so the only way a row can
 * be read back here is through `apiUsageSink(db)` on the handle the caller
 * passed. A case reading a recorded row is therefore a statement about the
 * production path, not about a stub the suite handed in.
 *
 * ## What this suite is not
 *
 * It says nothing about the payloads the contract publishes: no case here
 * reaches a repository, so `540000`, the three latest transactions and the
 * `54 more items` count are untouched. The integration suite that owns those
 * runs against a seeded Postgres.
 */
import type { RegisteredConsumer } from './auth/clientIdentity';
import type { ServiceDatabase } from './repositories/database';
import type { RunningService } from './server';
import type { ErrorResponse } from '@marcos-corp/contracts-service-a';
import type { NewApiUsageEvent } from '@marcos-corp/db';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildConsumerRegistry,
  ConsumerRegistryError,
  fingerprintCredential,
} from './auth/clientIdentity';
import { EnvironmentError, loadServiceEnv } from './config/env';
import {
  createServiceApp,
  DEFAULT_BIND_HOST,
  describeError,
  EPHEMERAL_PORT,
  startHttpServer,
  startService,
} from './server';
import { flushMicrotasks } from './testing/routeInvocation';

/**
 * The version this deployment says it serves.
 *
 * Deliberately not `0.1.0`, the version the workspace holds: every row this
 * suite reads back has to carry the number the *environment* stated, and a
 * value that matched the manifest would pass just as well against a service
 * that read the manifest instead.
 */
const CONTRACT_VERSION = '7.3.1';

/** A value no rendered failure may reproduce. */
const DATABASE_PASSWORD = 'hunter2';

/** A connection string no case may reach, carrying a value none may echo. */
const DATABASE_URL = `postgres://service_a:${DATABASE_PASSWORD}@127.0.0.1:5432/service_a`;

/** Nothing this suite drives reaches a card, so the base only has to be legal. */
const CARD_MAPPING = { artBaseUrl: 'https://cdn.example.com/assets' };

/** Fixed, so nothing here depends on when it ran. */
const NOW = (): Date => new Date('2026-09-08T12:00:00.000Z');

const WEB_B_CREDENTIAL = 'qc_live_2a6d0f83b41c9e7d5028af61c3b94e70';

const WEB_B: RegisteredConsumer = {
  clientId: 'web-b',
  owner: 'team-b',
  credentialSha256: fingerprintCredential(WEB_B_CREDENTIAL),
};

/** A well-formed identifier, so a `404` is a lookup rather than a refusal. */
const COMPANY_ID = randomUUID();
const CARD_ID = randomUUID();

/** Above `REQUEST_BODY_LIMIT`, and nothing else about it matters. */
const OVERSIZED_BODY_BYTES = 32 * 1024;

/**
 * A handle that records `api_usage` rows and refuses everything else.
 *
 * The refusal is the claim: a route that read the database would fail loudly
 * here rather than quietly passing, which is what lets the ordering cases
 * below say a request was refused *before* a read rather than instead of one.
 */
function recordingDatabase(rows: NewApiUsageEvent[]): ServiceDatabase {
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'insert') {
        return () => ({
          values: (row: NewApiUsageEvent) => {
            rows.push(row);
            return Promise.resolve();
          },
        });
      }
      throw new Error(
        `no case in server.test.ts may reach the database, and one read '${String(property)}'`,
      );
    },
  }) as ServiceDatabase;
}

describe('createServiceApp, over a real Express stack', () => {
  const usageRows: NewApiUsageEvent[] = [];
  const unexpected: unknown[] = [];
  let service: RunningService;

  beforeAll(async () => {
    const app = createServiceApp({
      env: loadServiceEnv({
        DATABASE_URL,
        PORT: '4001',
        CONTRACT_VERSION,
      }),
      db: recordingDatabase(usageRows),
      consumers: [WEB_B],
      cardMapping: CARD_MAPPING,
      now: NOW,
      onUnexpected: (error) => {
        unexpected.push(error);
      },
      onUsageFailure: (error) => {
        unexpected.push(error);
      },
    });

    service = await startHttpServer(app, { port: EPHEMERAL_PORT });
  });

  afterAll(async () => {
    await service.close();
  });

  /** A request, with the body typed as what every failure here has to be. */
  async function call(
    path: string,
    init: Parameters<typeof fetch>[1] = {},
  ): Promise<{ status: number; body: ErrorResponse; headers: Headers }> {
    const response = await fetch(`${service.url}${path}`, init);
    return {
      status: response.status,
      body: await response.json() as ErrorResponse,
      headers: response.headers,
    };
  }

  /** The same request, carrying the credential `web-b` was issued. */
  async function callAsWebB(
    path: string,
    init: Parameters<typeof fetch>[1] = {},
  ): Promise<{ status: number; body: ErrorResponse; headers: Headers }> {
    return call(path, {
      ...init,
      headers: {
        authorization: `Bearer ${WEB_B_CREDENTIAL}`,
        'x-consumer-package': '@marcos-corp/web-b',
        ...init?.headers,
      },
    });
  }

  /**
   * The rows written since a mark, once the response's `finish` handler has
   * had a chance to run.
   *
   * The logger `void`s an asynchronous write from that handler, so the row is
   * not there yet at the moment `fetch` resolves. Polling rather than a single
   * flush, because how many turns that takes is not this suite's business.
   */
  async function rowsSince(mark: number): Promise<NewApiUsageEvent[]> {
    for (let attempt = 0; attempt < 50 && usageRows.length === mark; attempt += 1) {
      await flushMicrotasks();
    }
    return usageRows.slice(mark);
  }

  it('binds an ephemeral port and reports where it landed', () => {
    expect(service.port).toBeGreaterThan(0);
    expect(service.url).toBe(`http://${DEFAULT_BIND_HOST}:${String(service.port)}`);
  });

  it('answers a request from a registered consumer', async () => {
    // The positive control for the whole block: every case below asserts a
    // refusal, and all of them pass against a stack that refuses everything.
    const mark = usageRows.length;
    const { status, body } = await callAsWebB('/companies?bogus=1');

    expect(status).toBe(400);
    expect(body.code).toBe('validation_failed');
    expect(await rowsSince(mark)).toHaveLength(1);
  });

  it('refuses a request carrying no credential', async () => {
    const { status, body, headers } = await call('/companies');

    expect(status).toBe(401);
    expect(body.code).toBe('unauthenticated');
    expect(headers.get('www-authenticate')).toBe('Bearer realm="service-a"');
  });

  it('refuses a credential registered to nobody, and says which kind of refusal', async () => {
    const { status, body, headers } = await call('/companies', {
      headers: { authorization: 'Bearer not-a-credential-anyone-holds' },
    });

    expect(status).toBe(401);
    expect(body.code).toBe('unauthenticated');
    expect(headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('writes no api_usage row for a request it could not attribute', async () => {
    // Deliberate rather than an omission: a 401 is not a consumer using an
    // operation, and a placeholder client_id would put rows into the spec
    // section 9.4 query that no owner can be told about.
    const mark = usageRows.length;
    await call('/companies');

    await flushMicrotasks();
    expect(usageRows.slice(mark)).toHaveLength(0);

    // The control for that absence, on the same mark: an attributable request
    // does produce one, so the empty list above is about the 401 rather than
    // about a logger that never runs.
    await callAsWebB('/companies?bogus=1');
    expect(await rowsSince(mark)).toHaveLength(1);
  });

  it('records the operation, the consumer and the stated package on one row', async () => {
    const mark = usageRows.length;
    await callAsWebB('/companies?bogus=1');
    const [row] = await rowsSince(mark);

    expect(row?.operationId).toBe('listCompanies');
    expect(row?.clientId).toBe(WEB_B.clientId);
    expect(row?.consumerPackageName).toBe('@marcos-corp/web-b');
    expect(row?.responseStatusCode).toBe(400);
  });

  it('stamps the contract version the environment stated', async () => {
    // Not the version in this workspace's manifest. A deployment keeps
    // reporting the version it was built from after the tree moves on.
    const mark = usageRows.length;
    await callAsWebB('/companies?bogus=1');
    const [row] = await rowsSince(mark);

    expect(row?.contractVersion).toBe(CONTRACT_VERSION);
  });

  it('answers an unrouted path with the shared error payload, not HTML', async () => {
    const { status, body, headers } = await callAsWebB('/no-such-operation');

    expect(status).toBe(404);
    expect(body.code).toBe('not_found');
    expect(headers.get('content-type')).toContain('application/json');
  });

  it('records an unrouted request under the marker no operation can spell', async () => {
    const mark = usageRows.length;
    await callAsWebB('/no-such-operation');
    const [row] = await rowsSince(mark);

    expect(row?.operationId).toBe('<unrouted>');
    expect(row?.responseStatusCode).toBe(404);
  });

  it('converts a body Express cannot read into the contract\'s 400', async () => {
    const { status, body } = await callAsWebB(
      `/companies/${COMPANY_ID}/cards/${CARD_ID}/activation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{oops',
      },
    );

    expect(status).toBe(400);
    expect(body.code).toBe('validation_failed');
  });

  it('records a body it could not read as unrouted, because no route ran', async () => {
    // A consequence of the mount order rather than a wish: `express.json` sits
    // in front of the router, so `recordOperation` never happened. The row
    // still exists, which is the half that matters — the logger is mounted in
    // front of the parser precisely so a refused body is not invisible.
    const mark = usageRows.length;
    await callAsWebB(`/companies/${COMPANY_ID}/cards/${CARD_ID}/activation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    const [row] = await rowsSince(mark);

    expect(row?.operationId).toBe('<unrouted>');
    expect(row?.responseStatusCode).toBe(400);
  });

  it('converts an oversized body into the contract\'s 400, not a 413', async () => {
    const { status, body } = await callAsWebB(
      `/companies/${COMPANY_ID}/cards/${CARD_ID}/activation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmedLastFour: 'x'.repeat(OVERSIZED_BODY_BYTES) }),
      },
    );

    expect(status).toBe(400);
    expect(body.code).toBe('validation_failed');
  });

  it('answers a failing read with a 500 that leaks nothing', async () => {
    const before = unexpected.length;
    const { status, body } = await callAsWebB('/companies');

    expect(status).toBe(500);
    expect(body.code).toBe('internal_error');
    expect(JSON.stringify(body)).not.toContain('database');
    expect(unexpected).toHaveLength(before + 1);
  });

  it('records a failed request like any other', async () => {
    const mark = usageRows.length;
    await callAsWebB('/companies');
    const [row] = await rowsSince(mark);

    expect(row?.operationId).toBe('listCompanies');
    expect(row?.responseStatusCode).toBe(500);
  });

  it('does not advertise the framework it is built on', async () => {
    const { headers } = await callAsWebB('/companies?bogus=1');

    expect(headers.get('x-powered-by')).toBeNull();
  });
});

describe('createServiceApp', () => {
  const env = loadServiceEnv({ DATABASE_URL, PORT: '4001', CONTRACT_VERSION });

  const base = {
    env,
    db: recordingDatabase([]),
    cardMapping: CARD_MAPPING,
    now: NOW,
  };

  it('refuses an unusable consumer registry at build time', () => {
    // A misconfigured registry is a startup failure, never a 401 on every
    // request forever — and taking the consumer list rather than a built
    // registry is what makes that check impossible to skip.
    expect(() => createServiceApp({ ...base, consumers: [] }))
      .toThrow(ConsumerRegistryError);
  });

  it('refuses two consumers sharing one credential', () => {
    const twin: RegisteredConsumer = { ...WEB_B, clientId: 'web-a' };

    expect(() => createServiceApp({ ...base, consumers: [WEB_B, twin] }))
      .toThrow(ConsumerRegistryError);
  });

  it('builds an application from a usable registry', () => {
    // The control for both refusals above.
    expect(() => createServiceApp({ ...base, consumers: [WEB_B] })).not.toThrow();
  });

  it('mounts its routes without logging a line per operation', () => {
    // ts-rest logs `[ts-rest] Initialized GET /companies` and three more
    // unless it is told not to, which is noise in a suite and unstructured
    // output in a deployment's log.
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    try {
      createServiceApp({ ...base, consumers: [WEB_B] });
    } finally {
      spy.mockRestore();
    }

    expect(logged).toStrictEqual([]);
  });
});

describe('startHttpServer', () => {
  it('binds the host it was given', async () => {
    const app = createServiceApp({
      env: loadServiceEnv({ DATABASE_URL, PORT: '4001', CONTRACT_VERSION }),
      db: recordingDatabase([]),
      consumers: [WEB_B],
      cardMapping: CARD_MAPPING,
      now: NOW,
    });

    const service = await startHttpServer(app, { port: EPHEMERAL_PORT, host: '::1' });
    try {
      expect(service.url).toBe(`http://[::1]:${String(service.port)}`);

      // The positive control: the reported origin is one a client can dial.
      const response = await fetch(`${service.url}/companies`);
      expect(response.status).toBe(401);
      await response.text();
    } finally {
      await service.close();
    }
  });

  it('stops answering once it is closed', async () => {
    const app = createServiceApp({
      env: loadServiceEnv({ DATABASE_URL, PORT: '4001', CONTRACT_VERSION }),
      db: recordingDatabase([]),
      consumers: [WEB_B],
      cardMapping: CARD_MAPPING,
      now: NOW,
    });

    const service = await startHttpServer(app, { port: EPHEMERAL_PORT });
    const { url } = service;

    // The control, before the claim: it was answering a moment ago, so the
    // rejection below is the close rather than a listener that never bound.
    const before = await fetch(`${url}/companies`);
    expect(before.status).toBe(401);
    await before.text();

    await service.close();

    await expect(fetch(`${url}/companies`)).rejects.toThrow();
  });
});

describe('describeError', () => {
  it('renders an ordinary failure as its message', () => {
    expect(describeError(new Error('connect ECONNREFUSED 127.0.0.1:1')))
      .toBe('connect ECONNREFUSED 127.0.0.1:1');
  });

  it('renders every address behind an AggregateError, which carries none itself', () => {
    // The shape `pg` raises for a host that resolved to more than one address.
    // Its own `message` is the empty string, so the idiom this repository uses
    // elsewhere renders the single likeliest failure of a process that
    // connects to Postgres as nothing at all.
    const refused = new AggregateError([
      new Error('connect ECONNREFUSED ::1:5432'),
      new Error('connect ECONNREFUSED 127.0.0.1:5432'),
    ]);

    expect(refused.message).toBe('');
    expect(describeError(refused)).toBe(
      'connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432',
    );
  });

  it('falls back to the name of an error carrying no message', () => {
    // Not only an `AggregateError` thing, which is why the fallback is not
    // written inside the branch above.
    expect(describeError(new RangeError())).toBe('RangeError');
  });

  it('renders a thrown non-error', () => {
    expect(describeError('the pool is closed')).toBe('the pool is closed');
  });
});

describe('startService', () => {
  /** The startup failure a database that is not there produces, as rendered. */
  async function failureFrom(databaseUrl: string): Promise<string> {
    return startService({
      consumers: [WEB_B],
      cardMapping: CARD_MAPPING,
      source: { DATABASE_URL: databaseUrl, PORT: '4001', CONTRACT_VERSION },
    }).then(
      async (running) => {
        await running.close();
        return 'the database answered, so this case proves nothing';
      },
      (error: unknown) => describeError(error),
    );
  }

  it('refuses an environment it cannot use', async () => {
    await expect(startService({
      consumers: [WEB_B],
      cardMapping: CARD_MAPPING,
      source: {},
    })).rejects.toThrow(EnvironmentError);
  });

  it('refuses to start against a database it cannot reach', async () => {
    // A `Pool` connects lazily, so a service built on one starts happily
    // against a database that is not there and fails on the first request
    // instead. The check in `openServiceDatabase` is what makes this a startup
    // failure, which is the answer `config/env.ts` already gives for a
    // variable that is not set.
    expect(await failureFrom(`postgres://service_a:${DATABASE_PASSWORD}@127.0.0.1:1/service_a`))
      .toContain('ECONNREFUSED 127.0.0.1:1');
  });

  it('never echoes the connection string in a startup failure', async () => {
    // Re-read the rendered failure with a second reader rather than trusting
    // the sentence that says it redacts.
    const failure
      = await failureFrom(`postgres://service_a:${DATABASE_PASSWORD}@127.0.0.1:1/service_a`);

    expect(failure).toContain('DATABASE_URL');
    expect(failure).not.toContain(DATABASE_PASSWORD);
  });
});

describe('the consumer registry this suite builds', () => {
  it('resolves the credential every case above presents', () => {
    // The positive control for every 401 in this file: without it, a registry
    // that resolved nothing would pass each refusal case for the wrong reason.
    expect(buildConsumerRegistry([WEB_B]).resolve(WEB_B_CREDENTIAL)?.clientId)
      .toBe(WEB_B.clientId);
  });
});
