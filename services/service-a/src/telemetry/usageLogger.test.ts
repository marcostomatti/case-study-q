/**
 * Runtime suite for `usageLogger.ts`.
 *
 * The claim spec section 2.3 makes is one sentence — every request is logged
 * with the `client_id`, the endpoint and the contract version — and it hides
 * four separate things that can each be true or false independently. This file
 * is organised around them:
 *
 * - **A row is written, once, per request**, for a success and for an error
 *   response alike. A logger that only records the happy path answers "who is
 *   still calling this" with a number that is quietly too low.
 * - **The `client_id` comes from the resolved identity**, never from anything
 *   the caller stated about itself. The self-reported package name is recorded
 *   beside it precisely so the two can disagree in a query.
 * - **The status recorded is the one the response finished with**, so the row
 *   cannot be built before the handler has run.
 * - **A telemetry failure is reported, never swallowed and never fatal.** The
 *   response has already been sent by the time the sink runs.
 *
 * Two shapes recur, both for the reason the neighbouring `clientIdentity`
 * suite gives: a case asserting something was refused passes just as well
 * against a module that refuses everything, so every refusal here is paired
 * with a control that must still succeed, and every "this value was not used"
 * assertion is a re-read of the recorded row rather than a claim about intent.
 */
import type { UsageEvent, UsageSink } from './usageLogger';
import type { RegisteredConsumer } from '../auth/clientIdentity';
import type { Request, Response } from 'express';

import { EventEmitter } from 'node:events';

import { apiUsage } from '@marcos-corp/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import {
  buildConsumerRegistry,
  clientIdentityMiddleware,
  fingerprintCredential,
} from '../auth/clientIdentity';

import {
  apiUsageSink,
  CONSUMER_PACKAGE_HEADER,
  recordOperation,
  UNROUTED_OPERATION_ID,
  UNSTATED_CONSUMER_PACKAGE,
  usageLoggerMiddleware,
} from './usageLogger';

/** The version this deployment claims to serve, as `loadServiceEnv` reports it. */
const CONTRACT_VERSION = '0.1.0';

/** An operationId as `emitOpenApi` derives one from the ts-rest router keys. */
const DASHBOARD_OPERATION = 'getCompanyDashboard';

const WEB_B_CREDENTIAL = 'qc_live_2a6d0f83b41c9e7d5028af61c3b94e70';

const WEB_B: RegisteredConsumer = {
  clientId: 'web-b',
  owner: 'team-b',
  credentialSha256: fingerprintCredential(WEB_B_CREDENTIAL),
};

const REGISTRY = buildConsumerRegistry([WEB_B]);

/** Just enough of an Express response to carry a status and finish once. */
class FakeResponse extends EventEmitter {
  statusCode = 200;

  /** Ends the response the way Express does: status first, then the event. */
  finish(status: number): void {
    this.statusCode = status;
    this.emit('finish');
  }
}

/** Lets a floating sink promise settle before a case reads what it wrote. */
async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

interface DriveOptions {
  /** What a route named itself as, or nothing when no route matched. */
  readonly operationId?: string;
  /** The status the response finished with. */
  readonly status?: number;
  /** Extra request headers, as Express lowercases them. */
  readonly headers?: Record<string, string | string[]>;
  /** Replaces the recording sink, for the failure cases. */
  readonly sink?: UsageSink;
}

interface Driven {
  /** Every row the sink was handed, in order. */
  readonly rows: readonly UsageEvent[];
  /** Every failure `onFailure` was told about. */
  readonly failures: readonly { readonly error: unknown; readonly event: UsageEvent }[];
  /** How many times the middleware called `next()`. */
  readonly nextCalls: number;
  /** How many rows had been written before the response finished. */
  readonly rowsBeforeFinish: number;
}

/**
 * Drives one authenticated request all the way through to a finished response
 * and reports everything the logger did.
 *
 * The identity is attached by running the real `clientIdentityMiddleware`,
 * because attaching one is deliberately not exported: a hand-built request
 * would be testing a shape this service never produces.
 */
async function drive(options: DriveOptions = {}): Promise<Driven> {
  const rows: UsageEvent[] = [];
  const failures: { error: unknown; event: UsageEvent }[] = [];
  const req = {
    headers: {
      authorization: `Bearer ${WEB_B_CREDENTIAL}`,
      ...options.headers,
    },
  } as unknown as Request;
  const res = new FakeResponse();

  clientIdentityMiddleware(REGISTRY)(req, res as unknown as Response, () => {
    // The auth middleware ran and accepted; nothing else to do here.
  });

  let nextCalls = 0;
  usageLoggerMiddleware({
    contractVersion: CONTRACT_VERSION,
    sink: options.sink ?? ((event) => {
      rows.push(event);
    }),
    onFailure: (error, event) => {
      failures.push({ error, event });
    },
  })(req, res as unknown as Response, () => {
    nextCalls += 1;
  });

  if (options.operationId !== undefined) {
    recordOperation(req, options.operationId);
  }

  const rowsBeforeFinish = rows.length;
  res.finish(options.status ?? 200);
  await flush();

  return { rows, failures, nextCalls, rowsBeforeFinish };
}

/** The single row a case expects, or a failure naming what was written instead. */
function onlyRow(driven: Driven): UsageEvent {
  expect(driven.rows).toHaveLength(1);
  const [row] = driven.rows;
  if (row === undefined) {
    throw new Error(
      `expected exactly one api_usage row, and ${driven.rows.length} were written`,
    );
  }
  return row;
}

describe('usageLoggerMiddleware', () => {
  it('writes one row for a success response, carrying every column spec 2.3 names', async () => {
    const driven = await drive({ operationId: DASHBOARD_OPERATION, status: 200 });

    expect(onlyRow(driven)).toMatchObject({
      clientId: 'web-b',
      operationId: DASHBOARD_OPERATION,
      contractVersion: CONTRACT_VERSION,
      responseStatusCode: 200,
    });
  });

  it('writes one row for an error response too', async () => {
    const driven = await drive({ operationId: 'activateCard', status: 409 });

    expect(onlyRow(driven)).toMatchObject({
      clientId: 'web-b',
      operationId: 'activateCard',
      contractVersion: CONTRACT_VERSION,
      responseStatusCode: 409,
    });
  });

  it('records a server failure as usage, since a consumer failing is still a caller', async () => {
    const driven = await drive({ operationId: DASHBOARD_OPERATION, status: 500 });

    expect(onlyRow(driven).responseStatusCode).toBe(500);
  });

  it('lets the request proceed', async () => {
    const driven = await drive({ operationId: DASHBOARD_OPERATION });

    expect(driven.nextCalls).toBe(1);
  });

  it('writes nothing until the response has finished', async () => {
    const driven = await drive({ operationId: DASHBOARD_OPERATION });

    // The control is the row that exists afterwards: without it this case
    // passes against a logger that never writes anything at all.
    expect(driven.rowsBeforeFinish).toBe(0);
    expect(driven.rows).toHaveLength(1);
  });

  it('records the status the response finished with, not the one it started at', async () => {
    const driven = await drive({ operationId: DASHBOARD_OPERATION, status: 404 });

    const res = new FakeResponse();
    expect(res.statusCode).toBe(200);
    expect(onlyRow(driven).responseStatusCode).toBe(404);
  });

  it('records one row per request rather than one per process', async () => {
    const first = await drive({ operationId: DASHBOARD_OPERATION, status: 200 });
    const second = await drive({ operationId: 'listCompanies', status: 200 });

    expect(onlyRow(first).operationId).toBe(DASHBOARD_OPERATION);
    expect(onlyRow(second).operationId).toBe('listCompanies');
  });

  it('stamps the row at the instant the response finished', async () => {
    const before = Date.now();
    const driven = await drive({ operationId: DASHBOARD_OPERATION });
    const after = Date.now();

    const { occurredAt } = onlyRow(driven);
    expect(occurredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(occurredAt.getTime()).toBeLessThanOrEqual(after);
  });
});

describe('the operation a row is attributed to', () => {
  it('is the one the route recorded', async () => {
    const driven = await drive({ operationId: 'listCompanyTransactions' });

    expect(onlyRow(driven).operationId).toBe('listCompanyTransactions');
  });

  it('is the unrouted marker when no route claimed the request', async () => {
    // The control is the case above: a logger that always reported the marker
    // would pass this one and fail that one.
    const driven = await drive({ status: 404 });

    expect(onlyRow(driven).operationId).toBe(UNROUTED_OPERATION_ID);
  });

  it('cannot be mistaken for an operationId the contract could declare', () => {
    // `emitOpenApi` derives every operationId by camel-joining router keys, so
    // a real one is always a bare identifier. The marker must not be.
    expect(UNROUTED_OPERATION_ID).not.toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
  });

  it('does not leak from one request to the next', async () => {
    await drive({ operationId: DASHBOARD_OPERATION });
    const driven = await drive({ status: 404 });

    expect(onlyRow(driven).operationId).toBe(UNROUTED_OPERATION_ID);
  });
});

describe('the consumer package name', () => {
  it('is what the caller stated', async () => {
    const driven = await drive({
      operationId: DASHBOARD_OPERATION,
      headers: { [CONSUMER_PACKAGE_HEADER]: '@marcos-corp/web-b' },
    });

    expect(onlyRow(driven).consumerPackageName).toBe('@marcos-corp/web-b');
  });

  it('is the unstated marker when the caller said nothing', async () => {
    const driven = await drive({ operationId: DASHBOARD_OPERATION });

    expect(onlyRow(driven).consumerPackageName).toBe(UNSTATED_CONSUMER_PACKAGE);
  });

  it('never becomes the client_id, however it disagrees with the credential', async () => {
    const driven = await drive({
      operationId: DASHBOARD_OPERATION,
      headers: { [CONSUMER_PACKAGE_HEADER]: '@marcos-corp/service-b' },
    });

    const row = onlyRow(driven);
    // A copied credential is exactly this row: an id issued to web-b arriving
    // under another package's name. Both halves have to survive to see it.
    expect(row.clientId).toBe('web-b');
    expect(row.consumerPackageName).toBe('@marcos-corp/service-b');
  });

  it('is bounded, so a caller cannot make one row the size of a file', async () => {
    const driven = await drive({
      operationId: DASHBOARD_OPERATION,
      headers: { [CONSUMER_PACKAGE_HEADER]: 'p'.repeat(5000) },
    });

    const { consumerPackageName } = onlyRow(driven);
    expect(consumerPackageName.length).toBeLessThanOrEqual(128);
    expect(consumerPackageName.startsWith('p')).toBe(true);
  });

  it('is collapsed to one line, so one row cannot forge several', async () => {
    const driven = await drive({
      operationId: DASHBOARD_OPERATION,
      headers: { [CONSUMER_PACKAGE_HEADER]: ' @marcos-corp/web-b \n @marcos-corp/web-a ' },
    });

    expect(onlyRow(driven).consumerPackageName).toBe('@marcos-corp/web-b @marcos-corp/web-a');
  });

  it('is the unstated marker when the caller sent a blank one', async () => {
    const driven = await drive({
      operationId: DASHBOARD_OPERATION,
      headers: { [CONSUMER_PACKAGE_HEADER]: '   ' },
    });

    expect(onlyRow(driven).consumerPackageName).toBe(UNSTATED_CONSUMER_PACKAGE);
  });
});

describe('a request that reached the logger with no identity', () => {
  /** The logger, mounted without the auth middleware ever having run. */
  function mountWithoutIdentity(): () => void {
    const req = { headers: {} } as unknown as Request;
    const res = new FakeResponse();
    return () => {
      usageLoggerMiddleware({
        contractVersion: CONTRACT_VERSION,
        sink: () => undefined,
      })(req, res as unknown as Response, () => undefined);
    };
  }

  it('is refused loudly, because that is a mounting mistake', async () => {
    // Control: the same middleware behind the auth middleware writes a row, so
    // this case cannot pass against a logger that throws unconditionally.
    const driven = await drive({ operationId: DASHBOARD_OPERATION });
    expect(driven.rows).toHaveLength(1);

    expect(mountWithoutIdentity()).toThrow(/clientIdentityMiddleware did not/);
  });

  it('is refused before the response is sent rather than after it', async () => {
    const driven = await drive({ operationId: DASHBOARD_OPERATION });
    expect(driven.rows).toHaveLength(1);

    // Thrown from the middleware body, so Express turns it into a 500. A throw
    // from the `finish` handler instead would be an uncaught exception.
    expect(mountWithoutIdentity()).toThrow();
  });
});

describe('a sink that fails', () => {
  const boom = new Error('the database is unreachable');

  it('is reported rather than swallowed, when it throws', async () => {
    const driven = await drive({
      operationId: DASHBOARD_OPERATION,
      sink: () => {
        throw boom;
      },
    });

    expect(driven.failures).toHaveLength(1);
    expect(driven.failures[0]?.error).toBe(boom);
  });

  it('is reported rather than swallowed, when it rejects', async () => {
    const driven = await drive({
      operationId: DASHBOARD_OPERATION,
      sink: () => Promise.reject(boom),
    });

    expect(driven.failures).toHaveLength(1);
    expect(driven.failures[0]?.error).toBe(boom);
  });

  it('reports the row that was lost, so the failure is actionable', async () => {
    const driven = await drive({
      operationId: DASHBOARD_OPERATION,
      status: 200,
      sink: () => Promise.reject(boom),
    });

    expect(driven.failures[0]?.event).toMatchObject({
      clientId: 'web-b',
      operationId: DASHBOARD_OPERATION,
      contractVersion: CONTRACT_VERSION,
      responseStatusCode: 200,
    });
  });

  it('does not stop the request it was logging', async () => {
    const driven = await drive({
      operationId: DASHBOARD_OPERATION,
      sink: () => {
        throw boom;
      },
    });

    expect(driven.nextCalls).toBe(1);
  });
});

describe('the default failure reporter', () => {
  const boom = new Error('the database is unreachable');

  /**
   * Drives a failing sink with no `onFailure` supplied — the shape `server.ts`
   * will actually mount — and hands back what reached stderr.
   */
  async function reported(): Promise<readonly string[]> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };

    try {
      const req = {
        headers: { authorization: `Bearer ${WEB_B_CREDENTIAL}` },
      } as unknown as Request;
      const res = new FakeResponse();

      clientIdentityMiddleware(REGISTRY)(req, res as unknown as Response, () => undefined);
      recordOperation(req, DASHBOARD_OPERATION);
      usageLoggerMiddleware({
        contractVersion: CONTRACT_VERSION,
        sink: () => Promise.reject(boom),
      })(req, res as unknown as Response, () => undefined);

      res.finish(200);
      await flush();
    } finally {
      console.error = original;
    }

    return lines;
  }

  it('says something rather than losing the row silently', async () => {
    // An empty api_usage that should hold rows is the one reading this table
    // must never produce: it is indistinguishable from an unused operation.
    expect(await reported()).toHaveLength(1);
  });

  it('names the client, the operation, the version and the cause', async () => {
    const [line] = await reported();

    expect(line).toContain('web-b');
    expect(line).toContain(DASHBOARD_OPERATION);
    expect(line).toContain(CONTRACT_VERSION);
    expect(line).toContain(boom.message);
  });
});

describe('apiUsageSink', () => {
  const EVENT: UsageEvent = {
    occurredAt: new Date('2026-09-08T10:11:12.000Z'),
    clientId: 'web-b',
    operationId: DASHBOARD_OPERATION,
    contractVersion: CONTRACT_VERSION,
    responseStatusCode: 200,
    consumerPackageName: '@marcos-corp/web-b',
  };

  interface Issued {
    readonly text: string;
    readonly params: readonly unknown[];
  }

  /**
   * A real Drizzle database over a client that records rather than connects.
   *
   * Nothing else reads what this sink actually issues: `check-types` cannot
   * see a column that moved, and a suite against a real Postgres would report
   * a successful insert either way.
   */
  async function issued(): Promise<readonly Issued[]> {
    const statements: Issued[] = [];
    const client = {
      query(config: { text: string }, params: unknown[]) {
        statements.push({ text: config.text, params });
        return Promise.resolve({ rows: [], fields: [] });
      },
    };
    const db = drizzle(client as never, { schema: { apiUsage } });

    await apiUsageSink(db)(EVENT);
    return statements;
  }

  it('issues exactly one statement, and it inserts into api_usage', async () => {
    const statements = await issued();

    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toMatch(/^insert into "api_usage"/);
  });

  it('supplies a value for every column but the one the database generates', async () => {
    const [statement] = await issued();

    for (const column of [
      'occurred_at',
      'client_id',
      'operation_id',
      'contract_version',
      'response_status_code',
      'consumer_package_name',
    ]) {
      expect(statement?.text).toContain(`"${column}"`);
    }
    // The column list alone says nothing: Drizzle names every column of the
    // table whether or not a value was supplied and fills the gap with
    // `default`, so a dropped field is invisible above. The values list is
    // what discriminates — one `default` for the generated key, and a
    // placeholder for each of the six columns this service is responsible for.
    expect(statement?.text).toContain('values (default, $1, $2, $3, $4, $5, $6)');
  });

  it('binds every value rather than spelling it into the statement', async () => {
    const [statement] = await issued();

    expect(statement?.params).toEqual([
      EVENT.occurredAt.toISOString(),
      EVENT.clientId,
      EVENT.operationId,
      EVENT.contractVersion,
      EVENT.responseStatusCode,
      EVENT.consumerPackageName,
    ]);
    expect(statement?.text).not.toContain(EVENT.clientId);
    expect(statement?.text).not.toContain(EVENT.operationId);
  });
});
