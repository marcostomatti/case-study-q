/**
 * The composition root: the environment, the identity check, the usage log and
 * the contract's routes assembled into one Express application.
 *
 * Every module in this service takes what it needs as a parameter and reads
 * nothing from the outside world — `loadServiceEnv` is a function rather than
 * a parsed singleton, `buildConsumerRegistry` takes its consumers,
 * `apiUsageSink` takes a database handle and `cardMapper` takes the base URL
 * its artwork is served from. Each of those decisions is argued in its own
 * module and each of them ends here: this is the one file that has to know
 * where the values actually come from, which is the whole point of pushing the
 * knowledge to a single place.
 *
 * ## The mount order, and why every position is load-bearing
 *
 * 1. **`clientIdentityMiddleware`.** Spec section 2.3 says *every* request
 *    carries a `client_id` derived from credentials, so the check is mounted
 *    once for the application rather than per route — a per-route mount is a
 *    per-route chance to forget. A request it refuses never reaches anything
 *    below and produces no `api_usage` row, deliberately: a `401` is not a
 *    consumer using an operation, and attributing one to a placeholder id
 *    would put rows into the section 9.4 query that no owner can be told
 *    about.
 * 2. **`usageLoggerMiddleware`.** Behind the identity check because it reads
 *    the identity that check resolved, and it reads it in the middleware body
 *    rather than in the `finish` handler — so mounting these two the other way
 *    round is a `500` through the error handler rather than an uncaught
 *    exception thrown after the response was already sent.
 * 3. **`express.json`.** Behind the usage logger, so a body Express cannot
 *    read still produces a row. That row records `<unrouted>`, because the
 *    failure happens before any route runs and `recordOperation` is a
 *    statement each route makes about itself. Parsing an untrusted body only
 *    after the caller has been identified is the other half of the position: an
 *    anonymous caller gets a `401` and no parse.
 * 4. **The routes**, through `createExpressEndpoints`. `routes/router.ts`
 *    mounts no middleware of its own precisely so this order lives in one
 *    file.
 * 5. **`unroutedRequestHandler`**, then **`routeErrorHandler`**. Express
 *    answers an unknown path and an uncaught throw with an HTML page by
 *    default, which is the one response no consumer of this contract can
 *    parse. Both handlers convert them into the shared error payload; see
 *    `routes/errors.ts`.
 *
 * `createExpressEndpoints` mounts an error handler of its own between 4 and 5.
 * It is unreachable here — it answers `RequestValidationError`, which ts-rest
 * only raises for zod schemas, and every schema in
 * `@marcos-corp/contracts-service-a` is TypeBox. `routes/requestParsing.ts` is
 * what checks a request in this service, and its header has the measurement.
 *
 * ## Three entry points, in increasing order of what they assume
 *
 * - `createServiceApp` builds the application from values it is handed. It
 *   opens nothing, binds nothing and reads no environment, so a suite can
 *   drive the real stack against a fake database.
 * - `startHttpServer` binds an application. `EPHEMERAL_PORT` is why the
 *   parameter exists: a suite that binds a fixed port races anything else on
 *   the machine, and on macOS that race is lost often enough to be a flake
 *   rather than a theory.
 * - `startService` is the deployment path — it parses the environment, opens
 *   the connection pool and binds the port the environment names. This is
 *   where `pg` lands, which is what `repositories/database.ts` promises when
 *   it says a handle arrives as a parameter everywhere else.
 *
 * ## What this module still does not decide
 *
 * The registered consumers and the card-art base URL are deployment
 * configuration and arrive as parameters, exactly like everything else here.
 * `config/env.ts` declares three variables today and growing a fourth is that
 * module's decision, with its own closure cases; whoever stands this process
 * up — `docker/compose.yaml` and `scripts/demo.ts` — supplies the other two.
 */
import type { RegisteredConsumer } from './auth/clientIdentity';
import type { EnvSource, ServiceEnv } from './config/env';
import type { CardMappingOptions } from './mapping/cardMapper';
import type { ServiceDatabase } from './repositories/database';
import type { RouteClock } from './routes/dependencies';
import type { UnexpectedErrorReporter } from './routes/errors';
import type { UsageFailureReporter } from './telemetry/usageLogger';
import type { Express } from 'express';
import type { Server } from 'node:http';

import { once } from 'node:events';

import { contract } from '@marcos-corp/contracts-service-a';
import { createExpressEndpoints } from '@ts-rest/express';
import { drizzle } from 'drizzle-orm/node-postgres';
import express from 'express';
import { Pool } from 'pg';

import { buildConsumerRegistry, clientIdentityMiddleware } from './auth/clientIdentity';
import { loadServiceEnv } from './config/env';
import { routeErrorHandler, unroutedRequestHandler } from './routes/errors';
import { buildServiceRouter } from './routes/router';
import { apiUsageSink, usageLoggerMiddleware } from './telemetry/usageLogger';

/**
 * Ask the operating system for a free port.
 *
 * Named rather than written as a bare `0`, because the reason is not obvious
 * from the digit: a suite that binds a fixed port races every other process on
 * the machine, including a previous run of itself whose socket is still in
 * `TIME_WAIT`, and the failure is an intermittent `EADDRINUSE` that reads as a
 * flaky test rather than as a port collision.
 */
export const EPHEMERAL_PORT = 0;

/**
 * Where a listener binds unless told otherwise.
 *
 * Loopback, so nothing this repository starts is reachable from another host
 * by default. A container has to bind every interface to be reachable at all,
 * so `docker/compose.yaml` overrides this and publishes the port back to the
 * host's loopback instead — the interface is a deployment decision and this is
 * only its default.
 */
export const DEFAULT_BIND_HOST = '127.0.0.1';

/**
 * The largest request body this service will read.
 *
 * The one body the contract declares is a four-character string, so this is a
 * ceiling rather than a budget. Anything above it is refused by
 * `express.json` and converted into the contract's `400` — the document
 * publishes no `413`, and `routes/errors.ts` argues that at length.
 */
const REQUEST_BODY_LIMIT = '16kb';

/** The addresses that mean "every interface" and cannot be dialled as one. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

/** What a deployment's clock is. There is no other honest answer. */
const systemClock: RouteClock = () => new Date();

/** Everything `createServiceApp` needs, and nothing it could look up itself. */
export interface ServiceAppOptions {
  /**
   * The parsed environment, as `loadServiceEnv` produces it.
   *
   * The whole value rather than the one field the application reads, because
   * the field it reads is the contract version stamped onto every `api_usage`
   * row — and a literal typed next to a real environment is exactly how a
   * deployment starts reporting a version it does not serve.
   */
  readonly env: ServiceEnv;
  /** The connection this service reads through. Opened by the caller. */
  readonly db: ServiceDatabase;
  /**
   * The consumers this deployment can answer, as registration produced them.
   *
   * Handed over as a list rather than as a built registry so the validation in
   * `buildConsumerRegistry` cannot be skipped: an empty list, a duplicate
   * `client_id`, a shared credential or a plaintext one is a startup throw
   * here rather than a `401` on every request forever.
   */
  readonly consumers: readonly RegisteredConsumer[];
  /** What the card mapper needs beyond a row; today, where artwork is served. */
  readonly cardMapping: CardMappingOptions;
  /**
   * Where "now" comes from.
   *
   * Required, with no default, which is `routes/dependencies.ts`'s convention
   * and worth keeping at this layer too: a suite that meant to fix time and
   * silently got the wall clock reads the spend window against whenever it
   * happened to run. `startService` is the one caller that supplies the real
   * clock, because a deployment has no other answer.
   */
  readonly now: RouteClock;
  /** Told about a row that could not be stored. Reported to stderr by default. */
  readonly onUsageFailure?: UsageFailureReporter;
  /** Told about a failure nobody expected. Reported to stderr by default. */
  readonly onUnexpected?: UnexpectedErrorReporter;
}

/**
 * Builds the application: the middleware, the routes and the two handlers that
 * stop a response leaving in a shape the contract does not describe.
 *
 * Nothing here is asynchronous and nothing here is opened, so this is also the
 * function a suite drives. It throws only when the consumer registry is
 * unusable, which is the one input that cannot be fixed at runtime.
 */
export function createServiceApp(options: ServiceAppOptions): Express {
  const { cardMapping, consumers, db, env, now } = options;
  const registry = buildConsumerRegistry(consumers);
  const app = express();

  // Nothing downstream reads it and it names the framework to anyone probing.
  app.disable('x-powered-by');

  app.use(clientIdentityMiddleware(registry));
  app.use(usageLoggerMiddleware({
    contractVersion: env.contractVersion,
    sink: apiUsageSink(db),
    onFailure: options.onUsageFailure,
  }));
  app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

  createExpressEndpoints(
    contract,
    buildServiceRouter({ db, cardMapping, now }),
    app,
    // ts-rest logs a line per route to stdout otherwise, which is noise in a
    // suite and structured-log pollution in a deployment.
    { logInitialization: false },
  );

  app.use(unroutedRequestHandler());
  app.use(routeErrorHandler({ onUnexpected: options.onUnexpected }));

  return app;
}

/** A bound listener, and the way to give the port back. */
export interface RunningService {
  /** The port actually bound, which is the interesting half of `EPHEMERAL_PORT`. */
  readonly port: number;
  /** An origin a client can dial, with the wildcard hosts resolved to loopback. */
  readonly url: string;
  /**
   * Stops accepting and resolves once the listener is closed. A request that
   * is mid-answer is allowed to finish.
   */
  close(): Promise<void>;
}

/** Where `startHttpServer` binds. */
export interface HttpServerOptions {
  /** `EPHEMERAL_PORT` asks the operating system for a free one. */
  readonly port: number;
  /** Defaults to `DEFAULT_BIND_HOST`. */
  readonly host?: string;
}

/**
 * An origin that can be dialled.
 *
 * A wildcard bind has no address of its own, so reporting `http://0.0.0.0:...`
 * hands back a string that fails on some clients and silently means "this
 * machine" on others. Loopback is the address that is always right for the
 * process that did the binding. IPv6 literals are bracketed, which is the part
 * that is easy to forget until a URL parser rejects one.
 */
function originFor(host: string, port: number): string {
  const dialable = WILDCARD_HOSTS.has(host)
    ? DEFAULT_BIND_HOST
    : host;
  const authority = dialable.includes(':')
    ? `[${dialable}]`
    : dialable;

  return `http://${authority}:${String(port)}`;
}

/**
 * Closes a listener and resolves once it has stopped.
 *
 * `server.closeIdleConnections()` is deliberately **not** called alongside
 * this, which is worth stating because reaching for it is the obvious move:
 * an HTTP client that keeps its socket alive — which is every modern one,
 * including the `fetch` a suite calls — would otherwise hold the listener open
 * for the full `keepAliveTimeout`. Node has released idle connections from
 * `close()` itself since v19 and this package requires v22, so the extra call
 * changes nothing. Measured on Node 22.14: after a keep-alive `fetch`,
 * `close()` alone resolves in 0 ms. A line that looks load-bearing and is not
 * is worse than no line.
 *
 * A request that is mid-answer is still allowed to finish, which is the half
 * `closeAllConnections()` would have given up.
 */
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * Binds an application and reports where it landed.
 *
 * The `listening` event is awaited rather than the callback form, so a bind
 * that fails — an occupied port, an address this host does not hold — rejects
 * here instead of surfacing later as an application that answers nothing.
 */
export async function startHttpServer(
  app: Express,
  options: HttpServerOptions,
): Promise<RunningService> {
  const host = options.host ?? DEFAULT_BIND_HOST;
  const server = app.listen(options.port, host);
  await once(server, 'listening');

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error(
      'service-a bound a listener that reports no TCP address, so the port it is '
      + 'answering on cannot be read',
    );
  }

  return {
    port: address.port,
    url: originFor(host, address.port),
    close: async () => {
      await closeServer(server);
    },
  };
}

/** A connection pool, and the handle every repository takes. */
export interface ServiceDatabaseHandle {
  readonly db: ServiceDatabase;
  /** Ends the pool. Nothing may use `db` afterwards. */
  close(): Promise<void>;
}

/**
 * Renders a failure for an operator, including the one shape that renders as
 * nothing.
 *
 * `pg` reports a refused connection as an `AggregateError` — one sub-error per
 * resolved address — whose own `message` is the empty string, and
 * `AggregateError` passes `instanceof Error`. So the idiom this repository
 * uses elsewhere prints the prefix and no cause for the single likeliest
 * failure of any process that connects to Postgres. Measured on `pg` 8: a
 * literal `127.0.0.1` resolves to one address and raises an ordinary `Error`
 * carrying `connect ECONNREFUSED 127.0.0.1:5432`, while `localhost` resolves
 * to two and raises the empty `AggregateError` — so whether the naive idiom
 * loses the message depends on how the connection string spells its host,
 * which is not a thing anyone should have to know.
 *
 * The `|| error.name` half matters on its own: an `Error` with an empty
 * message is not only an `AggregateError` thing.
 *
 * Exported because anything else here that renders a database failure for a
 * human — `scripts/demo.ts` next — needs the same treatment, and a second copy
 * would be a second chance to write the naive version.
 */
export function describeError(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map(describeError).join('; ');
  }
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

/**
 * Opens the pool and proves it can be used before anything else runs.
 *
 * The check is the point. A `Pool` connects lazily, so a service built on one
 * starts happily against a database that is not there and fails on the first
 * request instead — which is the exact failure `config/env.ts` refuses to
 * allow for a missing variable, and it deserves the same answer.
 *
 * The rejected URL is never echoed. It carries a password, and a startup
 * failure is the most-copied text a service ever produces; `config/env.ts`
 * makes the same argument, and makes it a property of the built problem rather
 * than of whoever renders it.
 */
export async function openServiceDatabase(
  databaseUrl: string,
): Promise<ServiceDatabaseHandle> {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const client = await pool.connect();
    client.release();
  } catch (error) {
    await pool.end();
    throw new Error(
      'service-a cannot start: the database named by DATABASE_URL could not be reached. '
      + `Its value is not shown because it carries credentials. ${describeError(error)}`,
      { cause: error },
    );
  }

  return {
    db: drizzle({ client: pool }),
    close: async () => {
      await pool.end();
    },
  };
}

/** What `startService` needs that the environment does not state. */
export interface ServiceOptions {
  /** The consumers this deployment can answer. See `ServiceAppOptions`. */
  readonly consumers: readonly RegisteredConsumer[];
  /** Where card artwork is served from. See `mapping/cardMapper.ts`. */
  readonly cardMapping: CardMappingOptions;
  /** Defaults to `process.env`, which is what a deployment supplies. */
  readonly source?: EnvSource;
  /** Defaults to `DEFAULT_BIND_HOST`. A container binds every interface. */
  readonly host?: string;
  /** Defaults to the wall clock, which is a deployment's only honest answer. */
  readonly now?: RouteClock;
  /** Told about a row that could not be stored. Reported to stderr by default. */
  readonly onUsageFailure?: UsageFailureReporter;
  /** Told about a failure nobody expected. Reported to stderr by default. */
  readonly onUnexpected?: UnexpectedErrorReporter;
}

/**
 * Starts the service the way a deployment does: parse the environment, open
 * the pool, build the application, bind the port.
 *
 * Every failure is a throw before anything is listening — an unusable
 * environment from `loadServiceEnv`, an unreachable database from
 * `openServiceDatabase`, an unusable consumer registry from `createServiceApp`
 * and an unavailable port from `startHttpServer`. A service that cannot do its
 * job should not be answering requests while it says so.
 *
 * The pool is closed on any failure after it is opened, and by `close()` after
 * the listener has stopped. Ending it first would abort the requests still
 * being answered.
 */
export async function startService(options: ServiceOptions): Promise<RunningService> {
  const env = loadServiceEnv(options.source);
  const database = await openServiceDatabase(env.databaseUrl);

  try {
    const app = createServiceApp({
      env,
      db: database.db,
      consumers: options.consumers,
      cardMapping: options.cardMapping,
      now: options.now ?? systemClock,
      onUsageFailure: options.onUsageFailure,
      onUnexpected: options.onUnexpected,
    });
    const running = await startHttpServer(app, { port: env.port, host: options.host });

    return {
      port: running.port,
      url: running.url,
      close: async () => {
        await running.close();
        await database.close();
      },
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}
