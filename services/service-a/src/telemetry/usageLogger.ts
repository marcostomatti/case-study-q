/**
 * One `api_usage` row per request: the tier 1 obligation spec section 2.3
 * states, and the only thing in this service that exists for the governance
 * story rather than for the mobile view.
 *
 * The rule reads as bookkeeping and is not. It blocks nothing and approves
 * nothing, and it is in the MVP because **none of what it accumulates can be
 * added retroactively**. Three later decisions read only from these rows: the
 * affected-consumer list a major version needs (spec section 6.2), the usage
 * query acceptance criterion section 9.4 runs, and the "is anyone still calling
 * this" check that gates field retirement (spec section 6.4). A logger switched
 * on the week those questions are asked answers all three with silence that
 * looks like zero usage.
 *
 * Six decisions worth having before changing anything here:
 *
 * - **This middleware mounts behind `clientIdentityMiddleware`, never in front
 *   of it.** `api_usage.client_id` is `NOT NULL` and every row is evidence
 *   about a registered consumer, so a request that presented no usable
 *   credential is refused before it reaches here and produces no row. That is a
 *   deliberate boundary rather than an omission: a `401` is not a consumer
 *   using an operation, and attributing one to a placeholder id would put rows
 *   into the exact query section 9.4 runs that no owner can be told about.
 *   Reaching this middleware without an identity is therefore a wiring
 *   mistake, and `requireClientIdentity` throws for it here in the request
 *   pipeline — where Express turns it into a `500` — rather than later from a
 *   `finish` handler, where the same throw would be an uncaught exception
 *   taking the process down after the response was already sent.
 * - **The row is built when the response finishes, not when it arrives.** The
 *   status is the whole point of the `finish` hook: an error response is
 *   recorded exactly like a success, because a consumer failing against a
 *   version is usage and dropping it makes the retirement check optimistic in
 *   the one direction that costs somebody an outage.
 * - **The `operationId` is recorded by the route, not derived from the path.**
 *   `emitOpenApi` derives operationIds by camel-joining the ts-rest router keys
 *   and `api_usage` keys on them, so that id is what joins a recorded call back
 *   to a published operation. A URL can be rewritten in a non-breaking way and
 *   an `operationId` cannot, which makes the path the wrong thing to key on. A
 *   request no route claimed carries `UNROUTED_OPERATION_ID`, which is not a
 *   name `emitOpenApi` can produce — the row survives (a consumer calling a
 *   path this version does not serve is worth seeing) and joins to nothing.
 * - **`clientId` is resolved, `consumerPackageName` is claimed, and the pair is
 *   the point.** The first is derived from the presented credential and cannot
 *   be chosen by the caller; the second is whatever the caller put in a header.
 *   Keeping both is what makes a copied credential visible in one query — an id
 *   issued to `web-b` arriving under another package's name. So the stated name
 *   is recorded faithfully and is never allowed to influence the id.
 * - **Anything the caller states is bounded and flattened before it is
 *   stored.** The header is untrusted input reaching a `text` column: a
 *   megabyte of it would be a row nobody can read, and an embedded newline
 *   would let one row look like several in any line-oriented dump of this
 *   table.
 * - **The sink is a parameter.** `server.ts` hands in `apiUsageSink(db)`; a
 *   suite hands in a recorder. The same argument `loadServiceEnv` and
 *   `buildConsumerRegistry` make: importing this module must not require a
 *   database, and telemetry that can only be exercised against Postgres is
 *   telemetry nobody exercises.
 *
 * A sink failure is reported and never fatal. By the time it runs the response
 * has been sent, so there is no request left to fail — but a swallowed failure
 * would make an empty `api_usage` indistinguishable from an unused operation,
 * which is the one reading this table must never produce.
 */
import type { NewApiUsageEvent } from '@marcos-corp/db';
import type { Request, RequestHandler } from 'express';
import type { IncomingMessage } from 'node:http';

import { apiUsage } from '@marcos-corp/db';

import { requireClientIdentity } from '../auth/clientIdentity';

/**
 * The header a consumer states its own package name in.
 *
 * Deliberately not `User-Agent`, for the reason spec section 2.3 gives about
 * identity: a caller's account of itself is a claim. This one is recorded as a
 * claim and labelled as such in the schema, which is a different thing from
 * being trusted.
 */
export const CONSUMER_PACKAGE_HEADER = 'x-consumer-package';

/**
 * Recorded when the caller stated no package name.
 *
 * The column is `NOT NULL` and an empty string would be indistinguishable from
 * a caller that stated an empty one, so the absence is spelled out. The angle
 * brackets are what keep it out of the namespace a real value lives in — no npm
 * package name may contain one.
 */
export const UNSTATED_CONSUMER_PACKAGE = '<unstated>';

/**
 * Recorded when no route claimed the request.
 *
 * Same argument as the marker above, against a different namespace: every
 * `operationId` `emitOpenApi` derives is a camel-joined router key, so a value
 * carrying angle brackets can never collide with one. A join from `api_usage`
 * to the published operation list simply drops these rows, which is the correct
 * answer — the call was real and the operation was not.
 */
export const UNROUTED_OPERATION_ID = '<unrouted>';

/**
 * Longest self-reported package name stored. Long enough for any scoped npm
 * name, short enough that a caller cannot make one row the size of a file.
 */
const MAX_CONSUMER_PACKAGE_LENGTH = 128;

/** Any run of whitespace, including the newlines a stored value must not keep. */
const WHITESPACE_RUN = /\s+/g;

/**
 * One recorded call, in the shape `api_usage` stores it.
 *
 * Spelled exactly like the table's columns rather than like the contract's
 * fields, which inverts the convention the rest of this service follows. That
 * is `packages/db`'s decision and it is deliberate: every other table is
 * mapped away from because a contract derived from a schema publishes the
 * schema, and this table publishes nothing — a row is a fact *about* a
 * contract. Renaming here would break the join and buy nothing.
 */
export interface UsageEvent {
  /** When the response finished, stamped by this service rather than by the database. */
  readonly occurredAt: Date;
  /** Spec section 2.3's consumer identity, resolved from the presented credential. */
  readonly clientId: string;
  /** The published `operationId`, or `UNROUTED_OPERATION_ID`. */
  readonly operationId: string;
  /** The contract version this deployment serves, as `loadServiceEnv` reports it. */
  readonly contractVersion: string;
  /** The status the response finished with. An error is recorded like a success. */
  readonly responseStatusCode: number;
  /** What the caller said it was. A claim, never an identity. */
  readonly consumerPackageName: string;
}

/** Where a recorded call goes. `apiUsageSink` is the one that reaches Postgres. */
export type UsageSink = (event: UsageEvent) => void | Promise<void>;

/** Told about a row that could not be stored, with the row that was lost. */
export type UsageFailureReporter = (error: unknown, event: UsageEvent) => void;

/** What `usageLoggerMiddleware` needs to record a request. */
export interface UsageLoggerOptions {
  /** Where rows go. */
  readonly sink: UsageSink;
  /**
   * The contract version this deployment serves. Stated by the deployment and
   * never read from the workspace manifest — see `config/env.ts`, which is
   * where `server.ts` gets it.
   */
  readonly contractVersion: string;
  /** What to do with a row that could not be stored. Reported by default. */
  readonly onFailure?: UsageFailureReporter;
}

/**
 * The one database capability this module needs, stated as a port rather than
 * as a Drizzle type.
 *
 * Two reasons, and neither is testability on its own. A `NodePgDatabase` in the
 * signature would put a driver in the exported surface of a module whose entire
 * job is to hand over six values, and it would tie this file to the connection
 * strategy `services/service-a/src/repositories/` gets to choose. The
 * colocated `.test-d.ts` asserts a real `NodePgDatabase` satisfies this, which
 * is what keeps the port honest — a structural interface nothing checks against
 * the real driver is a fake with extra steps.
 */
export interface UsageDatabase {
  insert(table: typeof apiUsage): {
    values(row: NewApiUsageEvent): PromiseLike<unknown>;
  };
}

/**
 * The operation a route claimed for a request, keyed on the request object.
 *
 * A `WeakMap` rather than a property on `Request`, for the reason
 * `clientIdentity.ts` gives at length: a global `declare module` either makes
 * every request in the workspace claim an operation it may not have, or makes
 * the field optional and every read site free to skip the check.
 */
const operationByRequest = new WeakMap<object, string>();

/**
 * Names the operation answering this request, for the row written when it
 * finishes.
 *
 * Called by each route implementation, which is the only place that knows its
 * own key in the ts-rest router — and those keys are exactly the ids
 * `emitOpenApi` publishes. A route that forgets produces an
 * `UNROUTED_OPERATION_ID` row rather than a wrong one.
 *
 * The parameter is `IncomingMessage` rather than Express's `Request`, which is
 * wider than it looks and narrower than it reads. `@ts-rest/express` hands a
 * route a `TsRestRequest`, an express `Request` whose `query`, `params` and
 * `body` are narrowed to the operation's own types — and a `Request` with a
 * narrowed `query` is **not** assignable to `Request` with the default
 * `ParsedQs`, because those appear in property positions. So the one caller
 * this function exists for could not call it. `IncomingMessage` is the type
 * both shapes actually share, and it is also the honest one: a `WeakMap` key
 * needs object identity and nothing else, while still refusing a bare `{}`.
 */
export function recordOperation(req: IncomingMessage, operationId: string): void {
  operationByRequest.set(req, operationId);
}

/**
 * What the caller said about itself, bounded and flattened.
 *
 * Node folds repeated headers into one comma-joined string for everything but
 * `Set-Cookie`, but the type admits an array and a value that arrived as one
 * would otherwise be stored as `[object Object]`.
 */
function statedConsumerPackage(req: Request): string {
  const raw = req.headers[CONSUMER_PACKAGE_HEADER];
  const joined = Array.isArray(raw)
    ? raw.join(', ')
    : raw ?? '';
  const flattened = joined
    .replace(WHITESPACE_RUN, ' ')
    .trim();

  return flattened === ''
    ? UNSTATED_CONSUMER_PACKAGE
    : flattened.slice(0, MAX_CONSUMER_PACKAGE_LENGTH);
}

/**
 * The default `onFailure`: say what was lost, on stderr.
 *
 * Never rethrows. This runs after the response has been sent, so a throw here
 * is an uncaught exception in a `finish` handler rather than a failed request.
 */
function reportUsageFailure(error: unknown, event: UsageEvent): void {
  const reason = error instanceof Error
    ? error.message || error.name
    : String(error);

  console.error(
    `service-a could not record api_usage for client_id '${event.clientId}' calling `
    + `'${event.operationId}' at contract version ${event.contractVersion}: ${reason}`,
  );
}

/** Hands a row to the sink, reporting rather than propagating any failure. */
async function storeUsage(
  sink: UsageSink,
  event: UsageEvent,
  onFailure: UsageFailureReporter,
): Promise<void> {
  try {
    await sink(event);
  } catch (error) {
    onFailure(error, event);
  }
}

/**
 * The middleware that records every request, mounted once for the whole
 * application behind `clientIdentityMiddleware`.
 *
 * Mounted once rather than per route for the reason the auth middleware gives:
 * spec section 2.3 says *every* request, and a per-route mount is a per-route
 * chance to forget. What is per route is the `recordOperation` call, and a
 * route that forgets that one still produces a row.
 */
export function usageLoggerMiddleware(options: UsageLoggerOptions): RequestHandler {
  const { contractVersion, sink } = options;
  const onFailure = options.onFailure ?? reportUsageFailure;

  return (req, res, next) => {
    // Read the identity now, not in the `finish` handler: a request that got
    // here without one is a mounting mistake, and this is the last moment at
    // which saying so can still become a response rather than a crash.
    const { clientId } = requireClientIdentity(req);
    const consumerPackageName = statedConsumerPackage(req);

    res.once('finish', () => {
      void storeUsage(sink, {
        occurredAt: new Date(),
        clientId,
        operationId: operationByRequest.get(req) ?? UNROUTED_OPERATION_ID,
        contractVersion,
        responseStatusCode: res.statusCode,
        consumerPackageName,
      }, onFailure);
    });

    next();
  };
}

/**
 * The sink that reaches Postgres: one `INSERT` per recorded call.
 *
 * No batching and no queue. Three consumers at demo volume do not need one, and
 * a buffer is where telemetry gets lost on shutdown — which for this table
 * means a gap that later reads as "nobody called that operation".
 */
export function apiUsageSink(db: UsageDatabase): UsageSink {
  return async (event: UsageEvent): Promise<void> => {
    await db.insert(apiUsage)
      .values({
        occurredAt: event.occurredAt,
        clientId: event.clientId,
        operationId: event.operationId,
        contractVersion: event.contractVersion,
        responseStatusCode: event.responseStatusCode,
        consumerPackageName: event.consumerPackageName,
      });
  };
}
