/**
 * Runtime suite for `clientIdentity.ts`.
 *
 * Three claims, in the order spec section 2.3 makes them: a request with no
 * usable credential is refused, a credential that resolves yields the
 * `client_id` it was issued to, and the resolved identity is reachable from
 * the request the rest of the service will read it off.
 *
 * Two shapes recur and are worth reading once:
 *
 * - **Every refusal case carries a positive control.** `refuse` asserts the
 *   registry it was handed still resolves the credential it was built from,
 *   because a case that only asserts "this was refused" passes just as well
 *   against a module that refuses everything.
 * - **Every rejection is re-read for the credential that produced it.** The
 *   body and the headers are searched for the presented value rather than the
 *   module being trusted to say it redacted one — a renderer cannot see its
 *   own leak.
 */
import type {
  ClientIdentity,
  ClientIdentityResolution,
  ConsumerRegistry,
  RegisteredConsumer,
} from './clientIdentity';
import type { Request, Response } from 'express';

import { ERROR_CODES } from '@marcos-corp/contracts-service-a';
import { describe, expect, it } from 'vitest';

import {
  buildConsumerRegistry,
  clientIdentityMiddleware,
  ConsumerRegistryError,
  CREDENTIAL_SCHEME,
  fingerprintCredential,
  readClientIdentity,
  requireClientIdentity,
  resolveClientIdentity,
  UNAUTHENTICATED_STATUS,
} from './clientIdentity';

/**
 * Credentials that look like issued ones rather than like placeholders: the
 * redaction cases search rendered output for them, and a value such as
 * `secret` would also match ordinary prose.
 */
const WEB_A_CREDENTIAL = 'qc_live_7f4b1e9a0c3d8256be71f0a4d9c2e5b8';
const WEB_B_CREDENTIAL = 'qc_live_2a6d0f83b41c9e7d5028af61c3b94e70';

const WEB_A: RegisteredConsumer = {
  clientId: 'web-a',
  owner: 'team-a',
  credentialSha256: fingerprintCredential(WEB_A_CREDENTIAL),
};

const WEB_B: RegisteredConsumer = {
  clientId: 'web-b',
  owner: 'team-b',
  credentialSha256: fingerprintCredential(WEB_B_CREDENTIAL),
};

const REGISTRY = buildConsumerRegistry([WEB_A, WEB_B]);

/** An `Authorization` header presenting a credential the normal way. */
function bearer(credential: string): string {
  return `${CREDENTIAL_SCHEME} ${credential}`;
}

/** The refusal half of a resolution. */
type RefusedResolution = Extract<ClientIdentityResolution, { ok: false }>;

/**
 * Drives a refusal and hands it back.
 *
 * The first assertion is the control: the registry under test must still
 * resolve a credential it was built from. Without it, every case in this file
 * passes against a `resolveClientIdentity` that returns a refusal
 * unconditionally.
 */
function refuse(
  header: string | undefined,
  registry: ConsumerRegistry = REGISTRY,
): RefusedResolution {
  expect(resolveClientIdentity(bearer(WEB_A_CREDENTIAL), registry).ok).toBe(true);

  const resolution = resolveClientIdentity(header, registry);
  if (resolution.ok) {
    throw new Error(
      `expected the header ${JSON.stringify(header)} to be refused, but it resolved to `
      + resolution.identity.clientId,
    );
  }
  return resolution;
}

/** Drives an accepted resolution and hands back the identity. */
function accept(header: string, registry: ConsumerRegistry = REGISTRY): ClientIdentity {
  const resolution = resolveClientIdentity(header, registry);
  if (!resolution.ok) {
    throw new Error(
      `expected the header ${JSON.stringify(header)} to resolve, but it was refused as `
      + resolution.rejection,
    );
  }
  return resolution.identity;
}

/** Drives `buildConsumerRegistry` to a refusal and hands back the error. */
function refuseRegistry(consumers: readonly RegisteredConsumer[]): ConsumerRegistryError {
  try {
    buildConsumerRegistry(consumers);
  } catch (err) {
    if (err instanceof ConsumerRegistryError) {
      return err;
    }
    throw err;
  }
  throw new Error('expected buildConsumerRegistry to refuse these consumers, but it built one');
}

/** Just enough of an Express request for the middleware to read a header off. */
function requestWith(authorization?: string): Request {
  const headers = authorization === undefined
    ? {}
    : { authorization };
  return { headers } as unknown as Request;
}

/** Records what the middleware wrote, so a case can read the whole response. */
class FakeResponse {
  statusCode: number | undefined;

  readonly headers: Record<string, string> = {};

  body: unknown;

  jsonCalls = 0;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  set(field: string, value: string): this {
    this.headers[field] = value;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    this.jsonCalls += 1;
    return this;
  }

  /** Everything the caller can see, as one string, for a redaction re-read. */
  rendered(): string {
    return JSON.stringify({ headers: this.headers, body: this.body, status: this.statusCode });
  }
}

interface Handled {
  readonly req: Request;
  readonly res: FakeResponse;
  readonly nextCalls: number;
}

/** Runs the middleware over one request and reports everything it did. */
function handle(authorization?: string, registry: ConsumerRegistry = REGISTRY): Handled {
  const req = requestWith(authorization);
  const res = new FakeResponse();
  let nextCalls = 0;

  clientIdentityMiddleware(registry)(req, res as unknown as Response, () => {
    nextCalls += 1;
  });

  return { req, res, nextCalls };
}

describe('fingerprintCredential', () => {
  it('is the lowercase hex SHA-256 of the credential', () => {
    // The NIST vector rather than a value this module produced: comparing the
    // digest against itself would agree with any algorithm change.
    expect(fingerprintCredential('abc'))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('does not contain the credential it was taken of', () => {
    expect(fingerprintCredential(WEB_A_CREDENTIAL)).not.toContain(WEB_A_CREDENTIAL);
    expect(fingerprintCredential(WEB_A_CREDENTIAL)).toHaveLength(64);
  });

  it('gives two credentials differing by one character entirely different digests', () => {
    const neighbour = `${WEB_A_CREDENTIAL.slice(0, -1)}9`;

    expect(neighbour).not.toBe(WEB_A_CREDENTIAL);
    expect(fingerprintCredential(neighbour)).not.toBe(fingerprintCredential(WEB_A_CREDENTIAL));
  });
});

describe('resolveClientIdentity, given no credential', () => {
  it('refuses a request that carries no Authorization header at all', () => {
    expect(refuse(undefined).rejection).toBe('missing');
  });

  it('reads a blank Authorization header as nothing presented', () => {
    expect(refuse('').rejection).toBe('missing');
    expect(refuse('   ').rejection).toBe('missing');
  });

  it('reads a scheme with no credential after it as nothing usable', () => {
    expect(refuse(CREDENTIAL_SCHEME).rejection).toBe('malformed');
    expect(refuse(`${CREDENTIAL_SCHEME}   `).rejection).toBe('malformed');
  });

  it('says what the caller must do, without naming any registered consumer', () => {
    const { message } = refuse(undefined);

    expect(message).toContain('credential');
    expect(message).not.toContain(WEB_A.clientId);
    expect(message).not.toContain(WEB_B.clientId);
  });
});

describe('resolveClientIdentity, given a credential it does not recognise', () => {
  it('refuses a well-formed credential that is registered to nobody', () => {
    expect(refuse(bearer('qc_live_000000000000000000000000000000')).rejection).toBe('unknown');
  });

  it('refuses a credential differing from an issued one by a single character', () => {
    const neighbour = `${WEB_A_CREDENTIAL.slice(0, -1)}9`;

    expect(refuse(bearer(neighbour)).rejection).toBe('unknown');
  });

  it('refuses an issued credential presented in a different case', () => {
    expect(refuse(bearer(WEB_A_CREDENTIAL.toUpperCase())).rejection).toBe('unknown');
  });

  it('refuses a credential presented under another scheme', () => {
    expect(refuse(`Basic ${WEB_A_CREDENTIAL}`).rejection).toBe('malformed');
    expect(refuse(WEB_A_CREDENTIAL).rejection).toBe('malformed');
  });

  it('refuses a credential too long to be one, rather than hashing it', () => {
    expect(refuse(bearer('q'.repeat(4097))).rejection).toBe('unknown');
  });

  it('never reproduces what was presented in the refusal it renders', () => {
    expect(refuse(bearer(WEB_A_CREDENTIAL.toUpperCase())).message)
      .not.toContain(WEB_A_CREDENTIAL.toUpperCase());
  });
});

describe('resolveClientIdentity, given the credential issued to a consumer', () => {
  it('resolves the client_id and the owner it was issued to', () => {
    expect(accept(bearer(WEB_A_CREDENTIAL))).toEqual({ clientId: 'web-a', owner: 'team-a' });
  });

  it('tells two registered consumers apart', () => {
    expect(accept(bearer(WEB_B_CREDENTIAL))).toEqual({ clientId: 'web-b', owner: 'team-b' });
  });

  it('accepts the scheme in any case, because RFC 7235 says it is case-insensitive', () => {
    expect(accept(`bearer ${WEB_A_CREDENTIAL}`).clientId).toBe('web-a');
    expect(accept(`BEARER ${WEB_A_CREDENTIAL}`).clientId).toBe('web-a');
  });

  it('tolerates the whitespace an HTTP client is free to add around the header', () => {
    expect(accept(`  ${CREDENTIAL_SCHEME}   ${WEB_A_CREDENTIAL}  `).clientId).toBe('web-a');
  });
});

describe('buildConsumerRegistry', () => {
  it('registers every consumer it is given', () => {
    expect(REGISTRY.size).toBe(2);
    expect(REGISTRY.resolve(WEB_A_CREDENTIAL)?.clientId).toBe('web-a');
    expect(REGISTRY.resolve(WEB_B_CREDENTIAL)?.clientId).toBe('web-b');
  });

  it('refuses an empty registry, because a deployment that answers nobody is a mistake', () => {
    expect(refuseRegistry([]).problems).toEqual([
      'no consumers are registered, so this deployment could answer nobody',
    ]);
  });

  it('refuses a plaintext credential pasted into the digest field', () => {
    const pasted = { ...WEB_A, credentialSha256: WEB_A_CREDENTIAL };

    expect(refuseRegistry([pasted]).message).toContain('not the credential');
  });

  it('refuses a digest that is not a SHA-256 the module would produce', () => {
    const short = { ...WEB_A, credentialSha256: 'ba7816bf' };
    const shouted = { ...WEB_A, credentialSha256: fingerprintCredential('abc').toUpperCase() };

    expect(refuseRegistry([short]).problems).toHaveLength(1);
    expect(refuseRegistry([shouted]).problems).toHaveLength(1);
  });

  it('refuses a blank client_id or owner', () => {
    expect(refuseRegistry([{ ...WEB_A, clientId: '  ' }]).message).toContain('clientId');
    expect(refuseRegistry([{ ...WEB_A, owner: '' }]).message).toContain('owner');
  });

  it('refuses two consumers registering one client_id', () => {
    const clash: RegisteredConsumer = { ...WEB_B, clientId: WEB_A.clientId };
    const { problems } = refuseRegistry([WEB_A, clash]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`client_id '${WEB_A.clientId}'`);
    expect(problems[0]).toContain('consumers 0 and 1');
  });

  it('refuses two consumers sharing one credential, which nothing later could untangle', () => {
    const shared: RegisteredConsumer = { ...WEB_B, credentialSha256: WEB_A.credentialSha256 };
    const { problems } = refuseRegistry([WEB_A, shared]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('share one credential');
  });

  it('never prints a credential digest in a failure', () => {
    const shared: RegisteredConsumer = { ...WEB_B, credentialSha256: WEB_A.credentialSha256 };
    const error = refuseRegistry([WEB_A, shared]);

    expect(error.message).not.toContain(WEB_A.credentialSha256);
    expect(JSON.stringify(error.problems)).not.toContain(WEB_A.credentialSha256);
  });

  it('reports every unusable entry in one throw, not just the first', () => {
    const { problems } = refuseRegistry([
      { ...WEB_A, clientId: '' },
      { ...WEB_B, owner: '' },
    ]);

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('consumer 0');
    expect(problems[1]).toContain('consumer 1');
  });

  it('carries the problems as data, so a caller can report them its own way', () => {
    const error = refuseRegistry([]);

    expect(error.name).toBe('ConsumerRegistryError');
    expect(error).toBeInstanceOf(Error);
    expect(error.problems).toHaveLength(1);
  });
});

describe('clientIdentityMiddleware, given a request it refuses', () => {
  it('answers 401 and stops the request, when no credential is presented', () => {
    const { res, nextCalls } = handle(undefined);

    expect(res.statusCode).toBe(UNAUTHENTICATED_STATUS);
    expect(res.jsonCalls).toBe(1);
    expect(nextCalls).toBe(0);
  });

  it('answers 401 and stops the request, when the credential is not recognised', () => {
    const { res, nextCalls } = handle(bearer('qc_live_not_issued_to_anybody_at_all_00'));

    expect(res.statusCode).toBe(UNAUTHENTICATED_STATUS);
    expect(nextCalls).toBe(0);
  });

  it('answers with the contract shared error payload, code unauthenticated', () => {
    const body = handle(undefined).res.body as Record<string, unknown>;

    expect(body.code).toBe('unauthenticated');
    expect(ERROR_CODES).toContain(body.code);
    expect(typeof body.message).toBe('string');
    expect(Object.keys(body).sort()).toEqual(['code', 'message']);
  });

  it('omits fields rather than sending null or an empty list for it', () => {
    const body = handle(undefined).res.body as Record<string, unknown>;

    expect('fields' in body).toBe(false);
  });

  it('challenges with a bare realm when nothing was presented, per RFC 6750', () => {
    expect(handle(undefined).res.headers['WWW-Authenticate'])
      .toBe(`${CREDENTIAL_SCHEME} realm="service-a"`);
  });

  it('challenges with invalid_token when something unusable was presented', () => {
    expect(handle(bearer('qc_live_not_issued')).res.headers['WWW-Authenticate'])
      .toContain('error="invalid_token"');
  });

  it('attaches no identity to a request it refused', () => {
    const { req } = handle(bearer('qc_live_not_issued'));

    expect(readClientIdentity(req)).toBeUndefined();
    expect(() => requireClientIdentity(req)).toThrow(/did not\s+run/);
  });

  it('never echoes the presented credential anywhere in the response', () => {
    const { res } = handle(bearer(WEB_A_CREDENTIAL.toUpperCase()));

    expect(res.rendered()).not.toContain(WEB_A_CREDENTIAL.toUpperCase());
    expect(res.rendered()).not.toContain(WEB_A.credentialSha256);
  });
});

describe('clientIdentityMiddleware, given a request it accepts', () => {
  it('calls the next handler and writes no response of its own', () => {
    const { res, nextCalls } = handle(bearer(WEB_A_CREDENTIAL));

    expect(nextCalls).toBe(1);
    expect(res.jsonCalls).toBe(0);
    expect(res.statusCode).toBeUndefined();
  });

  it('exposes the resolved identity on the request the handlers receive', () => {
    const { req } = handle(bearer(WEB_A_CREDENTIAL));

    expect(readClientIdentity(req)).toEqual({ clientId: 'web-a', owner: 'team-a' });
    expect(requireClientIdentity(req)).toEqual({ clientId: 'web-a', owner: 'team-a' });
  });

  it('keeps one identity per request, so concurrent callers cannot be confused', () => {
    const first = handle(bearer(WEB_A_CREDENTIAL));
    const second = handle(bearer(WEB_B_CREDENTIAL));

    expect(requireClientIdentity(first.req).clientId).toBe('web-a');
    expect(requireClientIdentity(second.req).clientId).toBe('web-b');
  });
});

describe('requireClientIdentity', () => {
  it('throws for a request the middleware never saw, rather than reporting anonymity', () => {
    expect(() => requireClientIdentity(requestWith(bearer(WEB_A_CREDENTIAL))))
      .toThrow(/clientIdentityMiddleware did not run/);
  });

  it('returns the identity once the middleware has run over that request', () => {
    const { req } = handle(bearer(WEB_A_CREDENTIAL));

    expect(requireClientIdentity(req).owner).toBe('team-a');
  });
});
