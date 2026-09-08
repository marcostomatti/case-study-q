/**
 * Checking a request against the contract that published it.
 *
 * ## Why this module exists at all
 *
 * ts-rest validates a request part **only when its schema is a zod schema** —
 * `checkZodSchema` tests for a `safeParse` method and, finding none, returns
 * `{ success: true, data }` with the raw value untouched. Every schema in
 * `@marcos-corp/contracts-service-a` is TypeBox, per spec section 5, so
 * `@ts-rest/express` performs **no request validation whatsoever** for this
 * service. Measured on `@ts-rest/express@3.52.1`, and it is silent: a route
 * receives `req.query` verbatim, correctly typed as the contract's query type
 * and actually holding whatever strings the caller sent.
 *
 * So spec section 2.5's request half — "requests reject unknown fields" —
 * would be a sentence in a document that nothing enforced. This module is what
 * enforces it, and it does so against the published schema itself rather than
 * against a second, hand-written copy of it. A zod mirror of every request
 * shape would be exactly the drift the contract exists to prevent: two
 * spellings of one promise, with no gate comparing them.
 *
 * That is also why `@sinclair/typebox` is a dependency of this service and not
 * only of the contract package. The repo's split — TypeBox authors what
 * `packages/contracts-*` publishes, Zod validates everything internal — is
 * about *authoring*. Nothing here authors a schema; it runs the published one.
 * `repositories/pagination.ts` is the internal shape beside it, and it is Zod.
 *
 * ## The strictness lives here because the document cannot carry it
 *
 * `requestObject` sets `additionalProperties: false` on every request shape,
 * and for a **body** that survives into the emitted OpenAPI document. For a
 * **query** or a **path parameter** container it does not: `emitOpenApi`
 * explodes those into `parameters`, so the container object never appears and
 * its strictness becomes the provider's own to keep. This module is where it
 * is kept, for all three, from one schema.
 *
 * ## Coercion, and the direction it fails in
 *
 * A query string carries only strings, and `PaginationQuery` declares
 * integers. `coerceQueryValues` converts a **declared** scalar whose raw value
 * is an exact literal of that type, and leaves everything else alone for the
 * check to reject: `?limit=5` becomes `5`, `?limit=5.5`, `?limit=1&limit=2`
 * and `?limit[a]=1` all stay as they are and become a `400`. A key the schema
 * does not declare is never coerced, so an unknown field cannot be converted
 * into something that looks declared.
 *
 * Anything the schema declares that is not an integer, a number or a boolean
 * stays a string and therefore fails. That is deliberate rather than an
 * omission: a query parameter of a shape nobody wrote a conversion for fails
 * loudly on its first request instead of arriving as `'[object Object]'`.
 *
 * ## Defaults come from the document, not from a constant here
 *
 * `Value.Default` fills in every `default` the schema declares, which is what
 * makes `PaginationQuery`'s published `limit: 20` and `offset: 0` the numbers
 * the provider actually applies. A `PAGE_LIMIT_DEFAULT` restated in a route
 * would be a second copy of a figure a consumer read out of the document, and
 * the two would be free to disagree.
 *
 * ## The one schema shape this cannot check, and why it throws
 *
 * `Type.Unsafe` is this repo's idiom for a contract enum, and it exists
 * because the idiomatic TypeBox spellings emit `anyOf` of `const`s rather than
 * a JSON Schema `enum` — which house rule 3's "every enum carries an unknown
 * member" never sees, so spec section 2.5 would stop being enforced on the
 * schema. It is the right tool for a **response**.
 *
 * It cannot be checked. `Type.Unsafe` attaches no TypeBox kind, and
 * `Value.Check` throws `Unknown type` on it. Measured on
 * `@sinclair/typebox@0.34.52`, along with the fix that looks obvious and is
 * worse: supplying `[Kind]: 'String'` makes the check **pass for every
 * string**, because TypeBox's checker does not read a raw `enum` keyword at
 * all. A silent accept of an undeclared value is the one outcome a request
 * gate must never produce.
 *
 * So a request schema carrying one is refused loudly, with
 * `SCHEMA_NOT_CHECKABLE`. No request schema in this contract has one today —
 * the request shapes are integers and bounded strings — and
 * `requestParsing.test.ts` walks every request slot of every operation and
 * asserts it stays that way, so the day one is added the suite fails rather
 * than production. The answer when that day comes is
 * `Type.Union([Type.Literal(...)])`, which TypeBox checks correctly and which
 * loses nothing: a query and a path parameter are exploded into `parameters`,
 * so the house rule reads the emitted parameter schema rather than this one.
 *
 * ## The cast, and why there is exactly one
 *
 * ts-rest types every schema slot as `ContractPlainType<T>`, an opaque brand
 * over the payload type. At runtime the value in that slot **is** the TypeBox
 * schema — that is what `contractSchema` in the contract module arranges, and
 * `contract.test.ts` pins the runtime identity with `toBe`. So the cast below
 * is that one, read backwards, and pairing it with the `ContractPlainType<T>`
 * parameter is what makes the returned value carry the contract's own type:
 * a caller cannot hand over one operation's schema and read another's shape.
 */
import type { ErrorResponse } from '@marcos-corp/contracts-service-a';
import type { TSchema } from '@sinclair/typebox';
import type { ContractPlainType } from '@ts-rest/core';

import { Value } from '@sinclair/typebox/value';

import { validationFailed } from './errors';

/**
 * The prefix on the one failure here that is the provider's, not the caller's.
 *
 * Exported so a suite asserts the wording rather than only that something
 * threw — a bare TypeBox `Unknown type` names neither the schema, the
 * operation, nor anything a reader could act on, and it would reach an
 * operator as an anonymous `500`.
 */
export const SCHEMA_NOT_CHECKABLE = 'request gate cannot run:';

/** What a caller gets back: the contract's own type, or the contract's `400`. */
export type ParseOutcome<Value_> =
  | { readonly ok: true; readonly value: Value_ }
  | { readonly ok: false; readonly error: ErrorResponse };

/** An exact integer literal, sign included. No exponent, no decimal point. */
const INTEGER_LITERAL = /^-?\d+$/;

/** An exact decimal literal. Same rule, with an optional fractional part. */
const NUMBER_LITERAL = /^-?\d+(?:\.\d+)?$/;

/** The only two strings a declared boolean accepts. */
const BOOLEAN_LITERALS = new Map<string, boolean>([['true', true], ['false', false]]);

/**
 * How many distinct fields one refusal names.
 *
 * A bound rather than a preference: a body full of unknown keys would
 * otherwise become a message longer than the request that caused it. The
 * remainder is counted rather than dropped silently.
 */
const MAX_REPORTED_PROBLEMS = 10;

/**
 * The shape of every identifier this provider has ever issued.
 *
 * `CompanyId` and `CardId` are published as **opaque** bounded strings with no
 * `format`, deliberately, so migrating off UUID keys stays a provider-side
 * change no consumer can see. This constant is the other half of that
 * decision: the provider knows what it issues, and an identifier of a shape it
 * has never issued names nothing it holds.
 *
 * Answering `404` for one is therefore correct rather than lenient — the
 * catalogue's `not_found` already covers "does not exist" and "not yours" —
 * and it is what stops a Postgres `invalid input syntax for type uuid` from
 * surfacing as a `500` for a caller who simply typed a bad URL. When the key
 * type changes, this is the one line in the service that changes with it.
 */
const ISSUED_IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether this provider could have issued that identifier.
 *
 * Not a validation step and not published anywhere: a caller passing a
 * well-formed identifier nobody was issued gets the same `404`, so this only
 * decides whether the answer costs a database round trip.
 */
export function isIssuedIdentifier(value: string): boolean {
  return ISSUED_IDENTIFIER.test(value);
}

/** The one property this module reads out of a TypeBox object schema. */
interface DeclaredProperties {
  readonly properties?: Readonly<Record<string, { readonly type?: string } | undefined>>;
}

/** The runtime schema behind a ts-rest slot. See the header for the cast. */
function schemaOf<Value_>(slot: ContractPlainType<Value_>): TSchema {
  return slot as unknown as TSchema;
}

/** What the schema says a property holds, or nothing when it declares no such property. */
function declaredType(schema: TSchema, property: string): string | undefined {
  const { properties } = schema as DeclaredProperties;
  return properties?.[property]?.type;
}

/**
 * One query value, converted when it is an exact literal of its declared type.
 *
 * Everything else is returned untouched, which is what makes the check the
 * only place a request is rejected: this function never decides a request is
 * bad, it only decides whether it can hand the checker a number instead of a
 * string.
 */
function coerceValue(declared: string | undefined, value: unknown): unknown {
  if (declared === undefined || typeof value !== 'string') {
    return value;
  }

  if (declared === 'integer') {
    return INTEGER_LITERAL.test(value)
      ? Number(value)
      : value;
  }

  if (declared === 'number') {
    return NUMBER_LITERAL.test(value)
      ? Number(value)
      : value;
  }

  if (declared === 'boolean') {
    return BOOLEAN_LITERALS.get(value) ?? value;
  }

  return value;
}

/**
 * A fresh object carrying the raw query with declared scalars converted.
 *
 * Always a copy: `Value.Default` mutates what it is given, and `req.query` is
 * Express's own object, which the usage logger and any later middleware also
 * read.
 */
function coerceQueryValues(schema: TSchema, raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }

  const coerced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    coerced[key] = coerceValue(declaredType(schema, key), value);
  }

  return coerced;
}

/**
 * A TypeBox error path as the contract spells one.
 *
 * `Value.Errors` reports a JSON Pointer (`/limit`, `/items/1/amount`) and
 * `ErrorResponse.fields` publishes a dotted path with array positions as
 * indices, which is the same walk written the way the consumers here already
 * name their form fields. The empty pointer means the complaint is about the
 * payload itself rather than any field in it, and produces no entry.
 */
function dottedPath(pointer: string): string {
  return pointer
    .replace(/^\//, '')
    .split('/')
    .join('.');
}

/**
 * The refusal, as the contract's shared error payload.
 *
 * One problem per distinct path, first message wins. TypeBox reports a missing
 * required property twice — once as missing and once as the wrong type — and a
 * consumer reading two sentences about one field learns nothing from the
 * second.
 */
function describeFailure(schema: TSchema, value: unknown): ErrorResponse {
  const firstByPath = new Map<string, string>();
  for (const error of Value.Errors(schema, value)) {
    if (!firstByPath.has(error.path)) {
      firstByPath.set(error.path, error.message);
    }
  }

  const reported = [...firstByPath.entries()].slice(0, MAX_REPORTED_PROBLEMS);
  const omitted = firstByPath.size - reported.length;
  const problems = reported.map(([pointer, message]) => {
    const field = dottedPath(pointer);
    return field === ''
      ? message
      : `${field}: ${message}`;
  });

  if (omitted > 0) {
    problems.push(`${omitted} further problems were not reported`);
  }

  const fields = reported
    .map(([pointer]) => dottedPath(pointer))
    .filter((field) => field !== '');

  return validationFailed(problems.join('; '), fields);
}

/**
 * Checks an already-typed value against its schema. Shared by all three parts.
 *
 * The `try` is not defensive padding — it is the split every gate in this repo
 * makes, between "the request is bad", which is a returned refusal, and "this
 * check could not run", which is a throw naming what to fix. See
 * `SCHEMA_NOT_CHECKABLE` for the one thing that reaches it.
 */
function check<Value_>(
  slot: ContractPlainType<Value_>,
  candidate: unknown,
): ParseOutcome<Value_> {
  const schema = schemaOf(slot);

  let satisfied: boolean;
  try {
    satisfied = Value.Check(schema, candidate);
  } catch (cause) {
    throw new Error(
      `${SCHEMA_NOT_CHECKABLE} the request was neither accepted nor refused, because TypeBox `
      + 'cannot walk a schema this contract declares. The likeliest cause is a request '
      + 'schema built with `Type.Unsafe`, which emits a real JSON Schema `enum` and carries '
      + 'no TypeBox kind: see this module\'s header for the two idioms and which direction '
      + 'each is for.',
      { cause },
    );
  }

  return satisfied
    ? { ok: true, value: candidate as Value_ }
    : { ok: false, error: describeFailure(schema, candidate) };
}

/**
 * A request body or a path-parameter container, checked as it arrived.
 *
 * No coercion: a JSON body already carries its own types, and every path
 * parameter this contract declares is a string. A body that is not an object
 * at all — an array, a bare number, or nothing, which `express.json()` reports
 * as `{}` — fails here rather than reaching a route as a shape it was typed
 * not to receive.
 */
export function parseRequestPayload<Value_>(
  slot: ContractPlainType<Value_>,
  raw: unknown,
): ParseOutcome<Value_> {
  return check(slot, raw);
}

/**
 * Query parameters: coerced from strings, defaulted from the document, then
 * checked.
 *
 * The order matters in one direction only. Coercing first means a value the
 * caller sent is never overwritten by a default; defaulting before the check
 * means the checked value is the one a route acts on, so a bound the contract
 * states about `limit` is enforced against the number the provider will
 * actually use.
 */
export function parseQueryParameters<Value_>(
  slot: ContractPlainType<Value_>,
  raw: unknown,
): ParseOutcome<Value_> {
  const schema = schemaOf(slot);
  const coerced = coerceQueryValues(schema, raw);

  return check(slot, Value.Default(schema, coerced));
}
