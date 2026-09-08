/**
 * The contract's shared error payload, and the two Express handlers that stop
 * anything leaving this service in a different shape.
 *
 * Every 4xx and 5xx response of every operation in
 * `@marcos-corp/contracts-service-a` is `ErrorResponse`, and house rule 5
 * fails the build of a contract where one is not. That is a promise about the
 * document; this module is what makes it a promise about the process.
 *
 * ## The two paths a response can leave by, and why both need a handler
 *
 * A route returning `{ status, body }` is checked by `tsc` against the statuses
 * the contract declares, so the deliberate error paths cannot drift — a route
 * answering an undeclared status, or an error body that is not the shared
 * shape, is a `bun run check-types` failure. The builders below exist so those
 * bodies are written once rather than four times.
 *
 * The other path is everything that was never returned at all: a repository
 * throwing, a body that is not JSON, a URL no operation is published at.
 * Express answers each of those with an **HTML** error page by default, which
 * is a payload no consumer of this contract can parse and no schema in it
 * describes. `routeErrorHandler` and `unroutedRequestHandler` are what convert
 * them, and `server.ts` mounts both.
 *
 * ## What an error message may say
 *
 * `ErrorResponse.message` is for a human reading a log or a support ticket.
 * Its own schema says it carries no stack trace, no SQL and no identifier the
 * caller did not already send, so the `500` path deliberately answers a fixed
 * sentence and reports the real failure to the service's own log instead. The
 * consumer branches on `code`; the operator reads the log.
 *
 * ## Where the other spelling of this payload is
 *
 * `auth/clientIdentity.ts` builds its own `401` body inline, because it
 * refuses a request before any route is reached and must not depend on the
 * routing layer. Both are typed as `ErrorResponse`, so the two cannot drift
 * structurally; what they do not share is the wording, which is the part that
 * is allowed to differ.
 */
import type { ErrorCode, ErrorResponse } from '@marcos-corp/contracts-service-a';
import type { ErrorRequestHandler, RequestHandler } from 'express';

import { PageRequestError } from '../repositories/pagination';

/** A request the provider will not act on. The contract declares it on every operation. */
export const VALIDATION_FAILED_STATUS = 400;

/** Nothing is published at that address, or nothing there is this caller's. */
export const NOT_FOUND_STATUS = 404;

/** Well-formed, but the addressed thing is in the wrong state for it. */
export const CONFLICT_STATUS = 409;

/** The provider failed. Nothing about the request needs to change. */
export const INTERNAL_ERROR_STATUS = 500;

/**
 * What a `500` tells the caller.
 *
 * Fixed, and deliberately uninformative. Anything derived from the underlying
 * failure is a Postgres message, a connection string or a stack frame, none of
 * which `ErrorResponse.message` is allowed to carry and none of which a
 * consumer can act on. The detail goes to `onUnexpected` instead.
 */
const INTERNAL_ERROR_MESSAGE
  = 'service-a could not complete the request. The failure has been recorded.';

/**
 * How much of a request line an unrouted-path message may echo back.
 *
 * The caller sent it, so repeating it leaks nothing — but a URL is unbounded
 * input and an error message is not the place to discover that.
 */
const MAX_ECHOED_REQUEST_LENGTH = 200;

/** The lowest and highest status a caller-caused failure carries. */
const CLIENT_ERROR_RANGE = { min: 400, max: 499 } as const;

/**
 * The shared error payload, with the one convention that is easy to get wrong.
 *
 * `fields` is **omitted** when there is nothing to name, never `null` and
 * never `[]`. Spec section 2.5 has one spelling of empty and it is absence;
 * an empty array is a third one, and a consumer checking `fields.length` and a
 * consumer checking `'fields' in body` would disagree about the same response.
 */
export function errorBody(
  code: ErrorCode,
  message: string,
  fields: readonly string[] = [],
): ErrorResponse {
  return {
    code,
    message,
    ...fields.length === 0
      ? {}
      : { fields: [...fields] },
  };
}

/** The request did not satisfy the contract. `fields` names which parts. */
export function validationFailed(
  message: string,
  fields: readonly string[] = [],
): ErrorResponse {
  return errorBody('validation_failed', message, fields);
}

/**
 * The addressed thing does not exist, or is not this caller's to see.
 *
 * One code for both, which is the contract's decision rather than this
 * module's: telling an unauthorised caller which identifiers are real is a
 * disclosure, and the catalogue folds the two together to prevent it.
 */
export function notFound(message: string): ErrorResponse {
  return errorBody('not_found', message);
}

/** The request was well-formed and the thing is in the wrong state for it. */
export function conflict(message: string): ErrorResponse {
  return errorBody('conflict', message);
}

/** The provider failed. Carries no detail; see `INTERNAL_ERROR_MESSAGE`. */
export function internalError(): ErrorResponse {
  return errorBody('internal_error', INTERNAL_ERROR_MESSAGE);
}

/**
 * The subset of a `body-parser` failure this module reads.
 *
 * `express.json()` rejects a malformed or oversized payload by calling `next`
 * with an ordinary `Error` carrying a `type` (`entity.parse.failed`,
 * `entity.too.large`, `encoding.unsupported`) and an HTTP `status`. Neither is
 * in the `Error` interface, so they are read through this shape rather than
 * asserted onto it.
 */
interface BodyParserFailure {
  readonly type?: unknown;
  readonly status?: unknown;
}

/**
 * Whether a thrown value is `express.json()` refusing the request body.
 *
 * Keyed on `type` **and** a 4xx `status` together. `type` alone would also
 * match an unrelated error that happens to carry one, and `status` alone
 * matches anything a middleware chose to tag.
 */
function isBodyParserFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const { type, status } = error as unknown as BodyParserFailure;
  return typeof type === 'string'
    && type !== ''
    && typeof status === 'number'
    && status >= CLIENT_ERROR_RANGE.min
    && status <= CLIENT_ERROR_RANGE.max;
}

/**
 * Renders a body-parser refusal as the contract's `400`.
 *
 * Every one of them becomes `validation_failed`, including
 * `entity.too.large`, which HTTP would call `413`. That is not a mistake: the
 * contract publishes no `413` on any operation, and answering a status the
 * document does not declare is worse for a consumer than answering the
 * declared status that means "your request is not one I will act on". If a
 * size limit ever needs its own code, it is a contract change first — spec
 * section 6.1's additive path.
 */
function describeBodyParserFailure(error: Error): ErrorResponse {
  return validationFailed(`the request body could not be read: ${error.message}`);
}

/** What `routeErrorHandler` does with a failure nobody expected. */
export type UnexpectedErrorReporter = (error: unknown) => void;

/** Optional wiring for `routeErrorHandler`. */
export interface RouteErrorHandlerOptions {
  /**
   * Where the real cause of a `500` goes.
   *
   * A parameter for the reason `usageLoggerMiddleware` takes an `onFailure`:
   * a suite asserts what was reported rather than reading stderr, and a
   * deployment can send it somewhere other than a console.
   */
  readonly onUnexpected?: UnexpectedErrorReporter;
}

/** The default reporter: say what failed, on stderr, in full. */
function reportUnexpected(error: unknown): void {
  const reason = error instanceof Error
    ? error.stack ?? error.message ?? error.name
    : String(error);

  console.error(`service-a failed to answer a request: ${reason}`);
}

/**
 * The last handler in the stack: whatever went wrong, answer the contract's
 * shape.
 *
 * Mounted after `createExpressEndpoints`, so it sees everything a route threw
 * as well as everything the body parser refused. Three outcomes:
 *
 * - **A `PageRequestError` is a `400`.** That class exists for this: its own
 *   module says a page request that must not reach SQL is the contract's
 *   `400` and everything else is a `500`. Reaching here means an internal
 *   caller built a page the repository layer refuses — the routes validate
 *   against the contract's own `PaginationQuery` first, and both read the same
 *   published bounds, so the two cannot disagree about a request that came in
 *   over HTTP.
 * - **A body-parser refusal is a `400`**, with the parser's own reason.
 * - **Everything else is a `500`**, with no detail in the response and the
 *   whole error in the log.
 *
 * A failure that arrives after the response has already started is handed to
 * Express's default handler instead, which closes the connection. Writing a
 * second status onto a response that has one throws, and the throw would
 * replace a partly-delivered answer with a crash.
 */
export function routeErrorHandler(
  options: RouteErrorHandlerOptions = {},
): ErrorRequestHandler {
  const onUnexpected = options.onUnexpected ?? reportUnexpected;

  return (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error instanceof PageRequestError) {
      res.status(VALIDATION_FAILED_STATUS).json(validationFailed(error.message));
      return;
    }

    if (isBodyParserFailure(error) && error instanceof Error) {
      res.status(VALIDATION_FAILED_STATUS).json(describeBodyParserFailure(error));
      return;
    }

    onUnexpected(error);
    res.status(INTERNAL_ERROR_STATUS).json(internalError());
  };
}

/**
 * The handler for a request no operation claimed.
 *
 * Mounted after the router and before `routeErrorHandler`. Without it Express
 * answers an unknown path with an HTML page, which is the one response in this
 * service that no consumer's single error path can read — and the one most
 * likely to be hit, because a consumer that mistypes a URL gets here rather
 * than to any route.
 *
 * `not_found` is the honest code: nothing is published at that address. The
 * method and path are echoed back because the caller sent them and they are
 * the only useful thing to say, bounded so a pathological URL does not become
 * the whole payload.
 */
export function unroutedRequestHandler(): RequestHandler {
  return (req, res) => {
    const requestLine = `${req.method} ${req.originalUrl}`.slice(
      0,
      MAX_ECHOED_REQUEST_LENGTH,
    );

    res.status(NOT_FOUND_STATUS).json(
      notFound(`service-a publishes no operation at '${requestLine}'`),
    );
  };
}
