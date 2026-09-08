/**
 * Runtime suite for `errors.ts`.
 *
 * The builders are nearly trivial and their claims are not, because the two
 * things this module is for are both absences: a `fields` key that must not be
 * present when there is nothing to name, and a `500` message that must not
 * carry anything the failure knew.
 *
 * The handlers are what stop a response leaving in a shape no schema in the
 * contract describes. Express answers a throw and an unknown path with HTML by
 * default, so a suite that only exercised the deliberate error paths would say
 * nothing about the two most likely responses a misbehaving consumer sees.
 *
 * Both handlers are driven through a real Express application on an ephemeral
 * loopback port. A hand-built response object would let the assertions agree
 * with a handler that never reached Express at all — and the specific things
 * being asserted (that `express.json()`'s refusal is converted, that the
 * unrouted path is reached after the router declines it) are properties of the
 * stack rather than of the function.
 */
import type { ErrorResponse } from '@marcos-corp/contracts-service-a';
import type { AddressInfo } from 'node:net';

import { ERROR_CODES } from '@marcos-corp/contracts-service-a';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PageRequestError } from '../repositories/pagination';

import {
  conflict,
  errorBody,
  INTERNAL_ERROR_STATUS,
  internalError,
  NOT_FOUND_STATUS,
  notFound,
  routeErrorHandler,
  unroutedRequestHandler,
  VALIDATION_FAILED_STATUS,
  validationFailed,
} from './errors';

/** A value that would identify the failure if it ever reached a consumer. */
const LEAKED_SECRET = 'postgres://demo:hunter2@127.0.0.1:5432/service_a';

describe('errorBody', () => {
  it('omits fields entirely when there is nothing to name', () => {
    const body = errorBody('not_found', 'nothing here');

    expect(body).toStrictEqual({ code: 'not_found', message: 'nothing here' });
    expect('fields' in body).toBe(false);
  });

  it('omits fields for an empty list rather than emitting one', () => {
    // Spec section 2.5 has one spelling of empty and it is absence. An empty
    // array is a third one, and a consumer reading `fields.length` and a
    // consumer reading `'fields' in body` would disagree about the response.
    expect('fields' in errorBody('validation_failed', 'x', [])).toBe(false);
  });

  it('carries the fields it was given', () => {
    // The positive control for both cases above: without it, a builder that
    // dropped `fields` unconditionally would pass them.
    expect(errorBody('validation_failed', 'x', ['a.b']).fields).toStrictEqual(['a.b']);
  });

  it('copies the list rather than keeping the caller\'s array', () => {
    const fields = ['a'];
    const body = errorBody('validation_failed', 'x', fields);
    fields.push('b');

    expect(body.fields).toStrictEqual(['a']);
  });

  it.each([
    ['validationFailed', validationFailed('x'), 'validation_failed'],
    ['notFound', notFound('x'), 'not_found'],
    ['conflict', conflict('x'), 'conflict'],
    ['internalError', internalError(), 'internal_error'],
  ])('%s answers a code from the published catalogue', (_name, body, code) => {
    expect(body.code).toBe(code);
    expect(ERROR_CODES).toContain(body.code);
  });

  it('never lets a 500 carry a detail of its own', () => {
    // `internalError` takes no argument, which is the claim: there is no way
    // to put a Postgres message into a response from this module.
    expect(internalError().message).not.toContain(LEAKED_SECRET);
    expect(internalError().message.length).toBeGreaterThan(0);
  });
});

describe('the handlers, over a real Express stack', () => {
  const reported: unknown[] = [];
  let baseUrl = '';
  let close: () => Promise<void>;

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '1kb' }));

    app.get('/known', (_req, res) => {
      res.json({ ok: true });
    });
    app.post('/body', (req, res) => {
      res.json(req.body as unknown);
    });
    app.get('/throws', () => {
      throw new Error(`connection failed: ${LEAKED_SECRET}`);
    });
    app.get('/page-request', () => {
      throw new PageRequestError(['limit must be at most 100']);
    });
    app.get('/late', (_req, res, next) => {
      res.write('partial');
      next(new Error('too late'));
    });

    app.use(unroutedRequestHandler());
    app.use(routeErrorHandler({
      onUnexpected: (error) => {
        reported.push(error);
      },
    }));

    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(port)}`;
    close = async () => {
      await new Promise((resolve) => server.close(resolve));
    };
  });

  afterAll(async () => {
    await close();
  });

  /**
   * A request, with the parsed body typed as what every failure here must be.
   *
   * The options are spelled `Parameters<typeof fetch>[1]` rather than
   * `RequestInit`: the leaf `lib` is `ES2022` with no DOM, so that name is
   * neither a `tsc` type nor an eslint global here.
   */
  async function call(
    path: string,
    init?: Parameters<typeof fetch>[1],
  ): Promise<{ status: number; body: ErrorResponse }> {
    const response = await fetch(`${baseUrl}${path}`, init);
    return { status: response.status, body: await response.json() as ErrorResponse };
  }

  it('serves a route that works', async () => {
    // The positive control for the whole block: every case below asserts a
    // refusal, and all of them would pass against a stack that refused
    // everything.
    const response = await fetch(`${baseUrl}/known`);

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ ok: true });
  });

  it('answers an unrouted path with the shared error payload, not HTML', async () => {
    const { status, body } = await call('/no-such-operation');

    expect(status).toBe(NOT_FOUND_STATUS);
    expect(body.code).toBe('not_found');
    expect(body.message).toContain('GET /no-such-operation');
  });

  it('answers a known path with an unrouted method the same way', async () => {
    const { status, body } = await call('/known', { method: 'DELETE' });

    expect(status).toBe(NOT_FOUND_STATUS);
    expect(body.code).toBe('not_found');
  });

  it('converts a malformed JSON body into the contract\'s 400', async () => {
    const { status, body } = await call('/body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });

    expect(status).toBe(VALIDATION_FAILED_STATUS);
    expect(body.code).toBe('validation_failed');
  });

  it('converts an oversized body into the contract\'s 400, not a 413', async () => {
    // The contract publishes no `413` on any operation, so answering one would
    // be a status the document does not declare. `validation_failed` is the
    // declared status that means "not a request I will act on".
    const { status, body } = await call('/body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(2000) }),
    });

    expect(status).toBe(VALIDATION_FAILED_STATUS);
    expect(body.code).toBe('validation_failed');
  });

  it('accepts a body it can read', async () => {
    // The positive control for both body cases above.
    const response = await fetch(`${baseUrl}/body`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    });

    expect(await response.json()).toStrictEqual({ ok: true });
  });

  it('answers a PageRequestError with the contract\'s 400 and its own reason', async () => {
    const { status, body } = await call('/page-request');

    expect(status).toBe(VALIDATION_FAILED_STATUS);
    expect(body.code).toBe('validation_failed');
    expect(body.message).toContain('limit must be at most 100');
  });

  it('answers an unexpected throw with a 500 that leaks nothing', async () => {
    const before = reported.length;
    const { status, body } = await call('/throws');

    expect(status).toBe(INTERNAL_ERROR_STATUS);
    expect(body.code).toBe('internal_error');
    expect(JSON.stringify(body)).not.toContain(LEAKED_SECRET);
    expect(reported).toHaveLength(before + 1);
  });

  it('reports the real cause to the operator instead', async () => {
    // Re-read the reported error rather than trusting the response: the claim
    // is that the detail went somewhere, not that it went nowhere.
    await call('/throws');
    const latest = reported.at(-1);

    expect(latest).toBeInstanceOf(Error);
    expect((latest as Error).message).toContain(LEAKED_SECRET);
  });

  it('does not try to answer a response that has already started', async () => {
    // Writing a second status onto a started response throws, and the throw
    // would replace a partly-delivered answer with a crashed connection.
    const before = reported.length;
    const response = await fetch(`${baseUrl}/late`);

    expect(response.status).toBe(200);
    expect(reported).toHaveLength(before);
  });
});
