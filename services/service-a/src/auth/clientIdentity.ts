/**
 * Who is calling: the consumer identity spec section 2.3 requires on every
 * request, resolved by this service from the credential the request presented.
 *
 * The rule the spec states is short and the consequences are not. Every request
 * carries a `client_id` **derived from credentials** — never `User-Agent` —
 * logged alongside the endpoint and the contract version. With three consumers
 * that reads as ceremony; it is in the MVP because none of the history it
 * accumulates can be added retroactively. The affected-consumer list a major
 * version needs (spec section 6.2), the usage query (spec section 9.4) and the
 * "is anyone still calling this field" check that gates retirement (spec
 * section 6.4) all read rows that only exist if identity was recorded from the
 * first request onwards.
 *
 * "Derived from credentials" is the load-bearing half, and it is why this
 * module exists rather than a header read. A `client_id` a caller states about
 * itself is a claim; `User-Agent` is the same claim with a worse spelling.
 * Here the consumer presents a credential and the **provider** resolves the id,
 * so a row in `api_usage` is evidence rather than self-report. The table keeps
 * `consumer_package_name` beside it precisely so the two can be compared: when
 * a `client_id` issued to `web-b` arrives naming another package, that is a
 * copied credential, visible in one query.
 *
 * Six decisions worth having before changing anything here:
 *
 * - **The credential is an HTTP bearer token**, which is what the emitted
 *   document's `consumerCredential` security scheme declares. The contract
 *   deliberately declares no `Authorization` header *parameter*, because
 *   OpenAPI states a header parameter with that name SHALL be ignored —
 *   declaring one publishes a requirement no tool reads, which is worse than
 *   declaring nothing because it looks covered.
 * - **The registry holds a SHA-256 digest of the issued credential, not the
 *   credential.** A leaked deployment configuration then yields nothing a
 *   caller can present. That protection is only as good as issuance: a
 *   digest of a guessable credential is brute-forceable, so spec section 6.3's
 *   manual issuance has to mint high-entropy random values. This module
 *   refuses anything in the digest field that is not a 64-character lowercase
 *   hex string, which is what makes a pasted plaintext credential a startup
 *   failure rather than a registry entry nothing will ever match.
 * - **Lookup is a `Map` keyed on the digest**, and that is also the answer to
 *   timing. Comparing raw credentials byte by byte leaks how long a prefix
 *   matched; comparing digests does not, because an attacker cannot steer the
 *   digest without already holding the credential. No `timingSafeEqual` scan
 *   is needed and none is used.
 * - **The identity is hung on the request through a `WeakMap`, not by
 *   augmenting Express's `Request`.** A global `declare module` either makes
 *   every request in the workspace claim an identity it may not have, or makes
 *   the field optional and every read site free to skip the check. Neither is
 *   a property worth having. `requireClientIdentity` throws instead, so a
 *   route mounted outside this middleware fails loudly rather than serving an
 *   anonymous caller.
 * - **Attaching is not exported.** This middleware is the only writer, so
 *   "an identity on a request was resolved from a credential" holds by
 *   construction rather than by review. A later suite that needs a request
 *   carrying an identity runs the middleware with a one-entry registry.
 * - **Every refusal is the contract's shared error payload**, code
 *   `unauthenticated`, which is the `401` every operation in
 *   `@marcos-corp/contracts-service-a` declares. A second spelling of "what
 *   went wrong" here would be one the consumer's single error path does not
 *   handle.
 *
 * Zod validates the registry, and that is the internal/published split this
 * repository runs on: the contract is TypeBox because it is published and
 * every construct in it has to survive as JSON Schema (spec section 2.4);
 * deployment configuration is published nowhere, so the internal tool applies.
 *
 * Where the registry comes from is deliberately not decided here. `server.ts`
 * builds one and hands it in, the same way `loadServiceEnv` is a function
 * rather than a module-level parse: importing this module must not require a
 * configured machine.
 */
import type { ErrorResponse } from '@marcos-corp/contracts-service-a';
import type { Request, RequestHandler, Response } from 'express';

import { createHash } from 'node:crypto';

import { z } from 'zod';

/** The status every failure of this check produces. */
export const UNAUTHENTICATED_STATUS = 401;

/**
 * The `Authorization` scheme the emitted document's security scheme declares.
 * Exported because four consumers have to send it and a literal in each of
 * them is four places to get it wrong.
 */
export const CREDENTIAL_SCHEME = 'Bearer';

/** Names the protection space in the `WWW-Authenticate` challenge. */
const AUTHENTICATION_REALM = 'service-a';

/**
 * Longest presented credential this module will hash rather than refuse. Node
 * caps header size well below this; the bound is here so an oversized value is
 * refused by a stated rule rather than by whatever the runtime happens to do.
 */
const MAX_CREDENTIAL_LENGTH = 4096;

/** Longest `clientId` or `owner` a registry entry may carry. */
const MAX_FIELD_LENGTH = 128;

/** A SHA-256 digest as `fingerprintCredential` renders one. */
const CREDENTIAL_SHA256 = /^[0-9a-f]{64}$/;

/** Holds at least one non-whitespace character. */
const NON_BLANK = /\S/;

/** The code every refusal here carries, checked against the published catalogue. */
const UNAUTHENTICATED_CODE: ErrorResponse['code'] = 'unauthenticated';

/**
 * A resolved consumer.
 *
 * `owner` travels with the id because every question the telemetry exists to
 * answer ends in "who do I tell" — spec section 6.2's affected-consumer list
 * and spec section 6.4's retirement notice both name a person, not an id.
 */
export interface ClientIdentity {
  /** Spec section 2.3's consumer identity. What `api_usage.client_id` records. */
  readonly clientId: string;
  /** Who was named when the credential was issued (spec section 6.3). */
  readonly owner: string;
}

/**
 * One registered consumer, as deployment configuration states it.
 *
 * Registration is manual and the provider cannot refuse it (spec section 6.3):
 * a consumer asks, an id is issued with a named owner, and the provider is
 * informed rather than asked. This interface is the shape that registration
 * produces.
 */
export interface RegisteredConsumer {
  readonly clientId: string;
  readonly owner: string;
  /** Lowercase hex SHA-256 of the issued credential. Never the credential. */
  readonly credentialSha256: string;
}

/** Why a request carried no usable identity. All three answer `401`. */
export type CredentialRejection =
  /** Nothing was presented at all. */
  | 'missing'
  /** Something was presented, but it is not a bearer credential. */
  | 'malformed'
  /** A bearer credential was presented and it is registered to nobody. */
  | 'unknown';

/** What `resolveClientIdentity` answers. */
export type ClientIdentityResolution =
  | { readonly ok: true; readonly identity: ClientIdentity }
  | {
    readonly ok: false;
    readonly rejection: CredentialRejection;
    /** Safe to return to the caller: it never reproduces what was presented. */
    readonly message: string;
  };

/** The refusal half of a resolution. */
type RefusedResolution = Extract<ClientIdentityResolution, { ok: false }>;

/** The registered consumers, in the only shape a request needs them in. */
export interface ConsumerRegistry {
  /** How many consumers are registered. For a startup log, and for a suite. */
  readonly size: number;
  /** The identity a credential was issued to, or nothing. */
  resolve(credential: string): ClientIdentity | undefined;
}

/**
 * Thrown when the registry cannot be built.
 *
 * A misconfigured registry is a startup failure, never a runtime one: a
 * service that starts with two consumers sharing a credential answers requests
 * it cannot attribute, and the rows it writes are wrong in a way no later
 * query can detect. `problems` is the same information as data, for a caller
 * that would rather emit structured logs than parse text — the same split
 * `EnvironmentError` makes.
 */
export class ConsumerRegistryError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(renderRegistryFailure(problems));
    this.name = 'ConsumerRegistryError';
    this.problems = problems;
  }
}

/**
 * Each message is written to follow the field name in a sentence
 * ("clientId must not be blank"), so each one starts with "must".
 */
const registeredConsumerSchema = z.object({
  clientId: z
    .string()
    .regex(NON_BLANK, 'must not be blank')
    .max(MAX_FIELD_LENGTH, `must be at most ${MAX_FIELD_LENGTH} characters`),
  owner: z
    .string()
    .regex(NON_BLANK, 'must not be blank')
    .max(MAX_FIELD_LENGTH, `must be at most ${MAX_FIELD_LENGTH} characters`),
  credentialSha256: z
    .string()
    .regex(
      CREDENTIAL_SHA256,
      'must be a lowercase hex SHA-256 digest of the issued credential, not the credential',
    ),
});

/**
 * The digest a registry entry carries for a given credential.
 *
 * Exported because whoever issues a credential has to produce this, and
 * because a suite building a registry has no other honest way to get one.
 */
export function fingerprintCredential(credential: string): string {
  return createHash('sha256')
    .update(credential, 'utf8')
    .digest('hex');
}

function renderRegistryFailure(problems: readonly string[]): string {
  const summary = 'service-a cannot start: the consumer registry is unusable.';
  return [summary, ...problems.map((problem) => `  ${problem}`)].join('\n');
}

/**
 * Every reason this list of consumers cannot become a registry, not just the
 * first: an operator fixing configuration should see the whole list once.
 *
 * A duplicate is reported by entry position and `clientId`, never by digest.
 * The digest is not the credential, but printing it buys nothing an operator
 * can act on and puts a value derived from a secret into a log.
 */
function registryProblems(consumers: readonly RegisteredConsumer[]): string[] {
  if (consumers.length === 0) {
    return ['no consumers are registered, so this deployment could answer nobody'];
  }

  const problems: string[] = [];
  const entryByClientId = new Map<string, number>();
  const entryByFingerprint = new Map<string, number>();

  consumers.forEach((consumer, index) => {
    const parsed = registeredConsumerSchema.safeParse(consumer);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push(`consumer ${index}: ${String(issue.path[0] ?? 'entry')} ${issue.message}`);
      }
      return;
    }

    const { clientId, credentialSha256, owner } = parsed.data;
    const firstWithId = entryByClientId.get(clientId);
    if (firstWithId === undefined) {
      entryByClientId.set(clientId, index);
    } else {
      problems.push(
        `consumers ${firstWithId} and ${index} both register the client_id '${clientId}', `
        + 'so a request could not be attributed to one owner',
      );
    }

    const firstWithCredential = entryByFingerprint.get(credentialSha256);
    if (firstWithCredential === undefined) {
      entryByFingerprint.set(credentialSha256, index);
    } else {
      problems.push(
        `consumers ${firstWithCredential} and ${index} ('${clientId}', owned by ${owner}) `
        + 'share one credential, so a request carrying it could not be attributed',
      );
    }
  });

  return problems;
}

/**
 * Builds the registry, or throws a `ConsumerRegistryError` naming every entry
 * that is unusable.
 *
 * An empty list is refused rather than accepted as "no consumers yet". A
 * deployment that can answer nobody is a configuration mistake, and one
 * refusal at startup reads better than a 401 on every request forever.
 */
export function buildConsumerRegistry(
  consumers: readonly RegisteredConsumer[],
): ConsumerRegistry {
  const problems = registryProblems(consumers);
  if (problems.length > 0) {
    throw new ConsumerRegistryError(problems);
  }

  const identityByFingerprint = new Map<string, ClientIdentity>();
  for (const consumer of consumers) {
    identityByFingerprint.set(consumer.credentialSha256, {
      clientId: consumer.clientId,
      owner: consumer.owner,
    });
  }

  return {
    size: identityByFingerprint.size,
    resolve(credential: string): ClientIdentity | undefined {
      if (credential === '' || credential.length > MAX_CREDENTIAL_LENGTH) {
        return undefined;
      }
      return identityByFingerprint.get(fingerprintCredential(credential));
    },
  };
}

/**
 * The credential out of an `Authorization` header, or nothing when the header
 * is not a bearer one.
 *
 * The scheme is compared case-insensitively because RFC 7235 says it is
 * case-insensitive, and a consumer whose HTTP client normalises it to
 * `bearer` is not a consumer with a credential problem.
 */
function bearerCredential(header: string): string | undefined {
  const separator = header.indexOf(' ');
  if (separator === -1) {
    return undefined;
  }
  if (header.slice(0, separator).toLowerCase() !== CREDENTIAL_SCHEME.toLowerCase()) {
    return undefined;
  }
  const credential = header.slice(separator + 1).trim();
  return credential === ''
    ? undefined
    : credential;
}

/**
 * Resolves the identity behind an `Authorization` header, or says why it
 * could not.
 *
 * Pure, and separate from the middleware on purpose: this is the rule spec
 * section 2.3 states, and it is worth being able to state it without an HTTP
 * request. The three rejections are distinguished for the operator reading a
 * log — they all produce the same `401` and the same code, because a consumer
 * branching on them would be branching on how far its own mistake got.
 */
export function resolveClientIdentity(
  authorizationHeader: string | undefined,
  registry: ConsumerRegistry,
): ClientIdentityResolution {
  const header = authorizationHeader?.trim() ?? '';
  if (header === '') {
    return {
      ok: false,
      rejection: 'missing',
      message: 'No credential was presented. Every request must carry the credential issued '
        + 'to a registered consumer.',
    };
  }

  const credential = bearerCredential(header);
  if (credential === undefined) {
    return {
      ok: false,
      rejection: 'malformed',
      message: `The Authorization header is not a ${CREDENTIAL_SCHEME} credential.`,
    };
  }

  const identity = registry.resolve(credential);
  if (identity === undefined) {
    return {
      ok: false,
      rejection: 'unknown',
      message: 'The presented credential is not recognised. Credentials are issued per '
        + 'consumer and are not transferable.',
    };
  }

  return { ok: true, identity };
}

/**
 * The identity resolved for a request, keyed on the request object itself.
 *
 * A `WeakMap` rather than a property on `Request`: see the header. Nothing
 * outside this module writes to it, which is what makes the presence of an
 * identity mean it was resolved from a credential.
 */
const identityByRequest = new WeakMap<object, ClientIdentity>();

/**
 * RFC 6750 distinguishes "you sent nothing" from "what you sent is no good",
 * and a client library acts on the difference: the first is a prompt to
 * attach a credential, the second is a prompt to stop retrying with this one.
 */
function challengeFor(rejection: CredentialRejection): string {
  const realm = `${CREDENTIAL_SCHEME} realm="${AUTHENTICATION_REALM}"`;
  return rejection === 'missing'
    ? realm
    : `${realm}, error="invalid_token"`;
}

/**
 * Answers the refusal.
 *
 * `fields` is absent rather than `null` or `[]`: the failure is not about any
 * request field, and one convention for empty is spec section 2.5's.
 */
function rejectRequest(res: Response, resolution: RefusedResolution): void {
  const body: ErrorResponse = {
    code: UNAUTHENTICATED_CODE,
    message: resolution.message,
  };
  res
    .status(UNAUTHENTICATED_STATUS)
    .set('WWW-Authenticate', challengeFor(resolution.rejection))
    .json(body);
}

/**
 * The middleware every route sits behind: resolve the caller, or refuse.
 *
 * Mounted once for the whole application rather than per route, because spec
 * section 2.3 says *every* request and a per-route mount is a per-route
 * chance to forget. A request it refuses never reaches a handler and never
 * gets an identity attached, so nothing downstream has to re-check.
 */
export function clientIdentityMiddleware(registry: ConsumerRegistry): RequestHandler {
  return (req, res, next) => {
    const resolution = resolveClientIdentity(req.headers.authorization, registry);
    if (!resolution.ok) {
      rejectRequest(res, resolution);
      return;
    }
    identityByRequest.set(req, resolution.identity);
    next();
  };
}

/**
 * The identity attached to a request, or nothing when the middleware did not
 * run. For a caller that has a reason to tolerate the absence; almost nothing
 * in this service does.
 */
export function readClientIdentity(req: Request): ClientIdentity | undefined {
  return identityByRequest.get(req);
}

/**
 * The identity attached to a request, or a throw.
 *
 * This is what the usage logger and the routes should call. Reaching a
 * handler with no identity means the handler is mounted outside the
 * middleware, which is a wiring bug that a silently-anonymous row in
 * `api_usage` would hide for as long as nobody queried it.
 */
export function requireClientIdentity(req: Request): ClientIdentity {
  const identity = identityByRequest.get(req);
  if (identity === undefined) {
    throw new Error(
      'no client identity is attached to this request, so clientIdentityMiddleware did not '
      + 'run before this handler. Spec section 2.3 requires an identity on every request, so '
      + 'this is a mounting mistake rather than an anonymous caller.',
    );
  }
  return identity;
}
