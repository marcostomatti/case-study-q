/**
 * Calling a ts-rest route implementation directly, with no HTTP server.
 *
 * A route built with `initServer().route(...)` is an ordinary async function
 * from the request's parts to `{ status, body }`. Everything a route decides —
 * which status, which error code, which fields it names, which operation it
 * records — is visible in that return value, so the suites under `routes/`
 * bind no port and parse no response.
 *
 * That is a deliberate split rather than a shortcut, and it is worth knowing
 * where the line is. What this helper cannot see is anything Express or
 * `createExpressEndpoints` does around a handler: route matching, `express
 * .json()` refusing a body, the mount order of the identity and usage
 * middleware, and the two handlers in `routes/errors.ts` that answer the paths
 * no route claims. Those are properties of the stack, and the suites that make
 * them — `routes/errors.test.ts` for the two handlers, `server.test.ts` for
 * the mount order, the service's integration suite for the payloads — run a
 * real application on an ephemeral loopback port instead.
 *
 * Test support, deliberately **not** re-exported from `src/index.ts`, for the
 * reason `src/testing/seededDatabase.ts` gives. It lives under `src/` so
 * `bun run check-types` and `bun run lint` both read it: a helper parked
 * beside the suites as a `*.test.ts` would be linted and never type-checked.
 */
import type { Request, Response } from 'express';

import { EventEmitter } from 'node:events';

/**
 * Just enough of an Express response to carry a status and finish once.
 *
 * `usageLoggerMiddleware` writes its row from a `finish` listener, so a suite
 * that wants to read what was recorded has to finish the response itself. A
 * real `ServerResponse` would need a socket.
 */
export class RecordingResponse extends EventEmitter {
  statusCode = 200;

  /** Ends the response the way Express does: status first, then the event. */
  finish(status: number): void {
    this.statusCode = status;
    this.emit('finish');
  }

  /** The same object, for a middleware whose parameter is typed `Response`. */
  asResponse(): Response {
    return this as unknown as Response;
  }
}

/**
 * A request carrying nothing but its headers.
 *
 * Headers are the only part of the raw request anything in this service reads:
 * `clientIdentityMiddleware` resolves the credential from `authorization` and
 * `usageLoggerMiddleware` reads the consumer package header. Everything else a
 * route uses arrives through the parts ts-rest destructures, which
 * `invokeRoute` supplies separately.
 *
 * Attach an identity by running the real `clientIdentityMiddleware` over the
 * returned object rather than by planting one: nothing exports a writer for
 * that `WeakMap`, on purpose, so a hand-planted identity would be testing a
 * shape this service never produces.
 */
export function fakeRequest(headers: Record<string, string | string[]> = {}): Request {
  return { headers } as unknown as Request;
}

/** The request parts a ts-rest handler destructures. Each defaults to `{}`. */
export interface RouteInput {
  readonly params?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
  /** Reuse a request the caller has already run middleware over. */
  readonly req?: Request;
  /** Reuse a response the caller intends to finish itself. */
  readonly res?: RecordingResponse;
}

/** What a route answered. */
export interface RouteAnswer<Body> {
  readonly status: number;
  readonly body: Body;
}

/**
 * The shape every route implementation in this service has, once its contract
 * types are erased.
 *
 * Erasing them is the point: a helper that kept them would need one overload
 * per operation, and each suite already knows which body it expects — it says
 * so through `Body`. The contract types are pinned where they belong, by
 * `tsc` over `routes/router.ts`, which refuses a status the contract does not
 * declare and an error code outside the published catalogue.
 */
type ErasedRouteHandler<Body> = (
  args: Record<string, unknown>,
) => Promise<RouteAnswer<Body>>;

/**
 * Calls a route with the parts it destructures, and hands back its answer.
 *
 * The handler is taken as `unknown` and cast once here rather than at every
 * call site: ts-rest types each implementation against its own operation, so
 * no single parameter type accepts all four.
 */
export async function invokeRoute<Body>(
  handler: unknown,
  input: RouteInput = {},
): Promise<RouteAnswer<Body>> {
  const req = input.req ?? fakeRequest();
  const res = input.res ?? new RecordingResponse();
  const call = handler as ErasedRouteHandler<Body>;

  return call({
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body ?? {},
    headers: req.headers,
    req,
    res,
  });
}

/**
 * Lets a floating promise settle before a case reads what it wrote.
 *
 * The usage logger's `finish` handler `void`s an async write, so a row is not
 * there yet when `emit('finish')` returns.
 */
export async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}
