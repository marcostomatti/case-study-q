import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Type } from '@sinclair/typebox';
import { initContract } from '@ts-rest/core';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { emitOpenApi, OPENAPI_VERSION, UnrepresentableSchemaError } from './emit';
import { lintSpec } from './lint';

/**
 * Gate 1's suite. Three claims, and each needs a different kind of evidence:
 *
 *   1. A representable contract emits a document that is not merely built but
 *      *usable* — so the last case in that block runs the real house ruleset
 *      over it through `lintSpec`. That is the assertion that would catch an
 *      emitter which inlines the shared error schema instead of referencing
 *      it: house rule 5 wants a literal `$ref` and reads the unresolved
 *      document, so an inlined lookalike passes every structural check here
 *      and fails gate 2 two tasks later.
 *   2. An unrepresentable schema throws, with a message naming its path. Run
 *      as a grid: every unpublishable construct at every slot a schema can sit
 *      in. A construct caught in a response but missed in a header is a gate
 *      with a hole in it, and one case per construct would never show it.
 *   3. The grid is not vacuous. Each slot carries a positive control using the
 *      same builder and a representable schema, which must emit. Without it a
 *      case passes just as well when the contract is broken for a reason that
 *      has nothing to do with the schema under test.
 *
 * The lint case shells out to the real `vacuum`, for the reason `lint.test.ts`
 * records: a stub would prove this file can parse its own output.
 */

const c = initContract();

const ErrorSchema = Type.Object({
  code: Type.String({ description: 'A machine-readable error code' }),
  message: Type.String(),
  fields: Type.Optional(Type.Array(Type.String())),
}, {
  $id: 'Error',
  additionalProperties: false,
  description: 'The shared error shape every operation returns',
});

const Money = Type.Object({
  amountMinor: Type.Integer({ description: 'Integer minor units. 5 400 kr is 540000' }),
  currency: Type.String({ pattern: '^[A-Z]{3}$' }),
}, { $id: 'Money', additionalProperties: false });

const CardState = Type.Unsafe<'active' | 'frozen' | 'unknown'>({
  $id: 'CardState',
  type: 'string',
  enum: ['active', 'frozen', 'unknown'],
  description: 'Carries an explicit unknown member, per spec section 2.5',
});

const Card = Type.Object({
  id: Type.String(),
  lastFour: Type.String({ pattern: '^[0-9]{4}$' }),
  state: CardState,
  legacyState: Type.Optional(Type.String({ deprecated: true, 'x-sunset': '2027-03-31' })),
}, { $id: 'Card', additionalProperties: false });

const CompanySummary = Type.Object({
  id: Type.String(),
  displayName: Type.String(),
}, { $id: 'CompanySummary', additionalProperties: false });

const Transaction = Type.Object({
  id: Type.String(),
  bookedAt: Type.String({ format: 'date-time' }),
  amount: Money,
  merchantName: Type.String(),
  settlement: Type.Unsafe<'settled' | 'pending' | 'unknown'>({
    type: 'string',
    enum: ['settled', 'pending', 'unknown'],
  }),
}, { $id: 'Transaction', additionalProperties: false });

const CompanyDashboard = Type.Object({
  company: CompanySummary,
  card: Card,
  // The same schema object twice: hoisting has to notice it is the same `$id`
  // and publish one component, not two or a collision.
  remainingSpend: Money,
  spendLimit: Money,
  latestTransactions: Type.Array(Transaction, { maxItems: 3 }),
  furtherTransactionCount: Type.Integer({ minimum: 0 }),
}, { $id: 'CompanyDashboard', additionalProperties: false });

/**
 * Shaped after the screen in `assets/mobile-view.png`, which is the API this
 * repo governs — a fixture that reads as the real contract catches the things
 * filler does not, like a component referenced from two places.
 */
const contract = c.router({
  listCompanies: {
    method: 'GET',
    path: '/companies',
    summary: 'Every company the caller may act for',
    responses: {
      200: Type.Object({
        companies: Type.Array(CompanySummary),
      }, { additionalProperties: false }),
      401: ErrorSchema,
    },
  },
  getCompanyDashboard: {
    method: 'GET',
    path: '/companies/:companyId/dashboard',
    pathParams: Type.Object({ companyId: Type.String() }, { additionalProperties: false }),
    responses: { 200: CompanyDashboard, 404: ErrorSchema },
  },
  listTransactions: {
    method: 'GET',
    path: '/companies/:companyId/transactions',
    pathParams: Type.Object({ companyId: Type.String() }, { additionalProperties: false }),
    query: Type.Object({
      limit: Type.Integer({ minimum: 1, maximum: 100 }),
      cursor: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    responses: {
      200: Type.Object({
        items: Type.Array(Transaction),
        nextCursor: Type.Optional(Type.String()),
      }, { $id: 'TransactionPage', additionalProperties: false }),
      400: ErrorSchema,
    },
  },
  cards: {
    activate: {
      method: 'POST',
      path: '/cards/:cardId/activation',
      pathParams: Type.Object({ cardId: Type.String() }, { additionalProperties: false }),
      body: Type.Object({
        activationCode: Type.String({ minLength: 6 }),
      }, { additionalProperties: false }),
      responses: { 200: Card, 409: ErrorSchema },
    },
    legacyActivate: {
      method: 'POST',
      path: '/cards/:cardId/activate',
      deprecated: true,
      // The only place a sunset date can live: ts-rest has a `deprecated`
      // flag and nowhere to put the date house rule 4 demands beside it.
      metadata: { 'x-sunset': '2027-03-31', internalOwner: 'team-a' },
      pathParams: Type.Object({ cardId: Type.String() }, { additionalProperties: false }),
      body: c.noBody(),
      responses: { 204: c.noBody(), 409: ErrorSchema },
    },
  },
});

const META = {
  info: { title: 'service-a', version: '0.1.0' },
} as const;

/** Reaches into the emitted document without narrowing at every step. */
const at = (document: unknown, path: string): unknown => path
  .split('.')
  .reduce<unknown>(
    (node, key) => (typeof node === 'object' && node !== null
      ? (node as Record<string, unknown>)[key]
      : undefined),
    document,
  );

let scratchDir = '';

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'contract-tooling-emit-'));
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('a representable contract', () => {
  const document = emitOpenApi(contract, META);

  it('emits OpenAPI 3.1, which is what carries JSON Schema 2020-12 unchanged', () => {
    expect(document.openapi).toBe(OPENAPI_VERSION);
    expect(document.openapi).toBe('3.1.0');
    expect(document.info).toEqual({ title: 'service-a', version: '0.1.0' });
  });

  it('rewrites ts-rest path parameters into OpenAPI path templates', () => {
    expect(Object.keys(document.paths ?? {})).toEqual([
      '/companies',
      '/companies/{companyId}/dashboard',
      '/companies/{companyId}/transactions',
      '/cards/{cardId}/activation',
      '/cards/{cardId}/activate',
    ]);
  });

  it('derives an operationId from the router keys, camel-joining nested ones', () => {
    expect(at(document, 'paths./companies.get.operationId')).toBe('listCompanies');
    expect(at(document, 'paths./cards/{cardId}/activation.post.operationId'))
      .toBe('cardsActivate');
  });

  it('emits a path parameter as required whatever else it carries', () => {
    expect(at(document, 'paths./companies/{companyId}/dashboard.get.parameters')).toEqual([
      { name: 'companyId', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('takes query parameter requiredness from the container schema', () => {
    const parameters = at(
      document,
      'paths./companies/{companyId}/transactions.get.parameters',
    ) as { name: string; in: string; required: boolean }[];

    expect(parameters.map(({ name, in: location, required }) => ({ name, location, required })))
      .toEqual([
        { name: 'companyId', location: 'path', required: true },
        { name: 'limit', location: 'query', required: true },
        { name: 'cursor', location: 'query', required: false },
      ]);
  });

  it('emits no header parameters for the empty headers object c.router() adds', () => {
    const parameters = at(document, 'paths./companies.get.parameters');

    // `c.router()` puts `headers: {}` on every route. Read as a schema that
    // constrains nothing it would be unrepresentable; read as a parameter
    // container it is simply empty, which is the only sane reading.
    expect(contract.listCompanies.headers).toEqual({});
    expect(parameters).toBeUndefined();
  });

  it('emits a request body for a mutation, and none for c.noBody()', () => {
    expect(at(document, 'paths./cards/{cardId}/activation.post.requestBody')).toEqual({
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['activationCode'],
            properties: { activationCode: { type: 'string', minLength: 6 } },
          },
        },
      },
    });
    expect(at(document, 'paths./cards/{cardId}/activate.post.requestBody')).toBeUndefined();
  });

  it('gives every response a description, preferring the schema over the status', () => {
    expect(at(document, 'paths./companies.get.responses.401.description'))
      .toBe('The shared error shape every operation returns');
    expect(at(document, 'paths./companies.get.responses.200.description')).toBe('OK');
    expect(at(document, 'paths./cards/{cardId}/activate.post.responses.204'))
      .toEqual({ description: 'No Content' });
  });

  it('references the shared error schema rather than inlining a copy of it', () => {
    // House rule 5 reads the unresolved document and wants this exact string.
    // An inlined lookalike satisfies every other assertion in this file.
    for (const path of [
      'paths./companies.get.responses.401',
      'paths./companies/{companyId}/dashboard.get.responses.404',
      'paths./companies/{companyId}/transactions.get.responses.400',
      'paths./cards/{cardId}/activation.post.responses.409',
    ]) {
      expect(at(document, `${path}.content.application/json.schema`))
        .toEqual({ $ref: '#/components/schemas/Error' });
    }
  });

  it('hoists every $id into components once, sorted, and refs it in place', () => {
    expect(Object.keys(document.components?.schemas ?? {})).toEqual([
      'Card',
      'CardState',
      'CompanyDashboard',
      'CompanySummary',
      'Error',
      'Money',
      'Transaction',
      'TransactionPage',
    ]);

    // Money is referenced from three places and published once.
    expect(at(document, 'components.schemas.CompanyDashboard.properties.remainingSpend'))
      .toEqual({ $ref: '#/components/schemas/Money' });
    expect(at(document, 'components.schemas.CompanyDashboard.properties.spendLimit'))
      .toEqual({ $ref: '#/components/schemas/Money' });
    expect(at(document, 'components.schemas.Transaction.properties.amount'))
      .toEqual({ $ref: '#/components/schemas/Money' });
    expect(at(document, 'components.schemas.Money.$id')).toBeUndefined();
  });

  it('copies only the x- prefixed metadata onto a deprecated operation', () => {
    const operation = at(document, 'paths./cards/{cardId}/activate.post') as Record<
      string,
      unknown
    >;

    expect(operation['deprecated']).toBe(true);
    expect(operation['x-sunset']).toBe('2027-03-31');
    // Internal metadata is not a consumer's business and must not leak.
    expect(operation['internalOwner']).toBeUndefined();
  });

  it('does not mutate the contract it was handed', () => {
    const before = JSON.stringify(contract);
    emitOpenApi(contract, META);

    expect(JSON.stringify(contract)).toEqual(before);
  });

  it('emits the same bytes twice, so the committed artifact does not churn', () => {
    expect(JSON.stringify(emitOpenApi(contract, META)))
      .toEqual(JSON.stringify(emitOpenApi(contract, META)));
  });

  it('produces a document that passes every house rule', async () => {
    const specPath = join(scratchDir, 'emitted.json');
    writeFileSync(specPath, JSON.stringify(document, null, 2));

    const result = await lintSpec(specPath);

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

/**
 * Every slot a schema can occupy, each as a builder taking the schema to put
 * there and the path the gate must report it at. `probe` is the router key, so
 * every path below starts with it.
 */
const SLOTS = [
  {
    slot: 'a response',
    path: 'probe.responses.200',
    build: (schema: unknown) => ({
      probe: { method: 'GET', path: '/probe', responses: { 200: schema } },
    }),
  },
  {
    slot: 'a nested property',
    path: 'probe.responses.200.properties.card.properties.activatedAt',
    build: (schema: unknown) => ({
      probe: {
        method: 'GET',
        path: '/probe',
        responses: {
          200: {
            type: 'object',
            additionalProperties: false,
            properties: {
              card: {
                type: 'object',
                additionalProperties: false,
                properties: { activatedAt: schema },
              },
            },
          },
        },
      },
    }),
  },
  {
    slot: 'array items',
    path: 'probe.responses.200.items',
    build: (schema: unknown) => ({
      probe: {
        method: 'GET',
        path: '/probe',
        responses: { 200: { type: 'array', items: schema } },
      },
    }),
  },
  {
    slot: 'a union member',
    path: 'probe.responses.200.anyOf.1',
    build: (schema: unknown) => ({
      probe: {
        method: 'GET',
        path: '/probe',
        responses: { 200: { anyOf: [{ type: 'string' }, schema] } },
      },
    }),
  },
  {
    slot: 'a request body',
    path: 'probe.body',
    build: (schema: unknown) => ({
      probe: {
        method: 'POST',
        path: '/probe',
        body: schema,
        responses: { 200: { type: 'string' } },
      },
    }),
  },
  {
    slot: 'a query parameter',
    path: 'probe.query.limit',
    build: (schema: unknown) => ({
      probe: {
        method: 'GET',
        path: '/probe',
        query: { type: 'object', additionalProperties: false, properties: { limit: schema } },
        responses: { 200: { type: 'string' } },
      },
    }),
  },
  {
    slot: 'a path parameter',
    path: 'probe.pathParams.probeId',
    build: (schema: unknown) => ({
      probe: {
        method: 'GET',
        path: '/probe/:probeId',
        pathParams: {
          type: 'object',
          additionalProperties: false,
          required: ['probeId'],
          properties: { probeId: schema },
        },
        responses: { 200: { type: 'string' } },
      },
    }),
  },
  {
    slot: 'a header',
    path: 'probe.headers.x-client-id',
    build: (schema: unknown) => ({
      probe: {
        method: 'GET',
        path: '/probe',
        headers: {
          type: 'object',
          additionalProperties: false,
          required: ['x-client-id'],
          properties: { 'x-client-id': schema },
        },
        responses: { 200: { type: 'string' } },
      },
    }),
  },
] as const;

/** One construct per reason the gate can refuse, with what the message must say. */
const UNREPRESENTABLE = [
  {
    construct: 'Type.Date()',
    reason: 'non-json-schema-type',
    mentions: '"Date"',
    value: () => Type.Date(),
  },
  {
    construct: 'Type.Function()',
    reason: 'non-json-schema-type',
    mentions: '"Function"',
    value: () => Type.Function([Type.String()], Type.String()),
  },
  {
    construct: 'a type array carrying a foreign member',
    reason: 'non-json-schema-type',
    mentions: '"Uint8Array"',
    // 2020-12 lets `type` be an array, so a check written for the string form
    // waves this through with one JavaScript type still in it.
    value: () => ({ type: ['string', 'Uint8Array'] }),
  },
  {
    construct: 'Type.Any()',
    reason: 'unconstrained',
    mentions: 'restricts nothing',
    value: () => Type.Any(),
  },
  {
    construct: 'Type.Transform()',
    reason: 'transform',
    mentions: 'Type.Transform',
    value: () => Type.Transform(Type.String()).Decode((v) => v)
      .Encode((v) => v),
  },
  {
    construct: 'c.type<T>()',
    reason: 'compile-time-type',
    mentions: 'compile time only',
    value: () => c.type<{ id: string }>(),
  },
  {
    construct: 'a Zod schema',
    reason: 'not-a-schema',
    mentions: 'Zod schema',
    value: () => ({ _def: { typeName: 'ZodString' } }),
  },
  {
    construct: 'a bare string',
    reason: 'not-a-schema',
    mentions: 'expected a JSON Schema object',
    value: () => 'CompanyDashboard',
  },
  {
    construct: 'Type.Ref() to nothing',
    reason: 'unresolvable-ref',
    mentions: 'which this document does not define',
    value: () => Type.Ref('NoSuchSchema'),
  },
  {
    construct: 'a $ref outside the document',
    reason: 'unresolvable-ref',
    mentions: 'points outside this document',
    value: () => ({ $ref: './other.yaml#/components/schemas/Error' }),
  },
] as const;

const grid = SLOTS.flatMap(
  (slot) => UNREPRESENTABLE.map((construct) => ({ ...slot, ...construct })),
);

describe('an unrepresentable schema', () => {
  it('has a grid to run at all', () => {
    // `it.each([])` registers nothing and reports success, so an empty product
    // would take every case below with it in silence.
    expect(grid).toHaveLength(SLOTS.length * UNREPRESENTABLE.length);
    // Every reason the gate can give has at least one construct behind it.
    expect(new Set(UNREPRESENTABLE.map(({ reason }) => reason)).size).toBe(6);
  });

  it.each(SLOTS)('emits cleanly with a representable schema in $slot', ({ build }) => {
    // The positive control. Without it, a case below passes just as well when
    // the builder produces a contract that is broken for some other reason.
    const document = emitOpenApi(
      build(Type.String({ minLength: 1 })) as Parameters<typeof emitOpenApi>[0],
      META,
    );

    expect(Object.keys(document.paths ?? {})).toHaveLength(1);
  });

  it.each(grid)('refuses $construct in $slot, naming the path', ({ build, path, reason, mentions, value }) => {
    const emit = (): unknown => emitOpenApi(
      build(value()) as Parameters<typeof emitOpenApi>[0],
      META,
    );

    expect(emit).toThrow(UnrepresentableSchemaError);

    let thrown: UnrepresentableSchemaError | undefined;
    try {
      emit();
    } catch (error) {
      thrown = error as UnrepresentableSchemaError;
    }

    expect(thrown?.path).toBe(path);
    expect(thrown?.reason).toBe(reason);
    // The path has to be IN the message, not merely on the error object: the
    // CI log is what a human reads, and `gates.ts` reports the message.
    expect(thrown?.message).toContain(`emit gate cannot represent '${path}'`);
    expect(thrown?.message).toContain(mentions);
  });
});

describe('constructs that look unpublishable and are not', () => {
  const emitResponse = (schema: unknown): unknown => emitOpenApi(
    { probe: { method: 'GET', path: '/probe', responses: { 200: schema } } } as Parameters<
      typeof emitOpenApi
    >[0],
    META,
  );

  it.each([
    ['an enum with no type', { enum: ['active', 'unknown'] }],
    ['a const with no type', { const: 'active' }],
    ['a composition with no type', { anyOf: [{ type: 'string' }, { type: 'integer' }] }],
    ['a boolean additionalProperties', { type: 'object', additionalProperties: false }],
  ])('emits %s', (_label, schema) => {
    expect(() => emitResponse(schema)).not.toThrow();
  });

  it('does not descend into const, default or examples, which hold values', () => {
    // The proof that the walk is keyword-driven rather than a deep object
    // walk. Every value below looks exactly like an unrepresentable schema and
    // none of them is one — they are example data.
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        marker: { type: 'object', additionalProperties: false, const: { type: 'Date' } },
      },
      default: { marker: { type: 'Function' } },
      examples: [{ marker: { type: 'Uint8Array' } }],
    };

    expect(() => emitResponse(schema)).not.toThrow();
  });
});

describe('Type.Never(), which is neither clearly publishable nor clearly not', () => {
  it('is refused, at the empty schema inside it', () => {
    // TypeBox emits `Type.Never()` as `{"not":{}}`. The outer node is real
    // JSON Schema, but the `{}` inside it is not something a consumer can
    // derive a type from, and a response no value can satisfy is not a
    // response. The gate names that inner node rather than the wrapper, which
    // is the honest answer to "which part cannot be published".
    let thrown: UnrepresentableSchemaError | undefined;
    try {
      emitOpenApi(
        { probe: { method: 'GET', path: '/probe', responses: { 200: Type.Never() } } } as Parameters<
          typeof emitOpenApi
        >[0],
        META,
      );
    } catch (error) {
      thrown = error as UnrepresentableSchemaError;
    }

    expect(thrown).toBeInstanceOf(UnrepresentableSchemaError);
    expect(thrown?.path).toBe('probe.responses.200.not');
    expect(thrown?.reason).toBe('unconstrained');
  });
});

describe('a contract the gate cannot run against', () => {
  const emit = (contractUnderTest: unknown, meta: unknown = META): unknown => emitOpenApi(
    contractUnderTest as Parameters<typeof emitOpenApi>[0],
    meta as Parameters<typeof emitOpenApi>[1],
  );

  const ok = { method: 'GET', path: '/probe', responses: { 200: { type: 'string' } } };

  it.each([
    ['a router with no routes', {}, 'declares no routes'],
    [
      'a route key holding something that is not a route',
      { probe: 'not a route' },
      'is neither a route nor a nested router',
    ],
    [
      'two routes producing one operationId',
      { cards: { activate: ok }, cardsActivate: { ...ok, path: '/other' } },
      'both produce operationId \'cardsActivate\'',
    ],
    [
      'the same method twice on one path',
      { first: ok, second: { ...ok } },
      'is a second GET on \'/probe\'',
    ],
    [
      'a path that is not rooted',
      { probe: { ...ok, path: 'probe' } },
      'does not start with',
    ],
    [
      'a path variable with no parameter',
      { probe: { ...ok, path: '/probe/:probeId' } },
      'do not agree',
    ],
    [
      'a parameter that is not in the path',
      {
        probe: {
          ...ok,
          pathParams: {
            type: 'object',
            additionalProperties: false,
            required: ['probeId'],
            properties: { probeId: { type: 'string' } },
          },
        },
      },
      'do not agree',
    ],
    [
      'an optional path parameter',
      {
        probe: {
          ...ok,
          path: '/probe/:probeId',
          pathParams: {
            type: 'object',
            additionalProperties: false,
            properties: { probeId: { type: 'string' } },
          },
        },
      },
      'is optional, but a path parameter is always required',
    ],
    [
      'a query schema that is not an object',
      { probe: { ...ok, query: { type: 'string' } } },
      'must be an object schema',
    ],
    [
      'a response key that is not a status code',
      { probe: { ...ok, responses: { ok: { type: 'string' } } } },
      'is not an HTTP status code',
    ],
    [
      'a route with no responses',
      { probe: { ...ok, responses: {} } },
      'declares no responses',
    ],
    [
      'a response declared as null rather than c.noBody()',
      { probe: { ...ok, responses: { 204: null } } },
      'expected a JSON Schema object and found null',
    ],
    [
      'two different schemas sharing one $id',
      {
        first: { ...ok, responses: { 200: { $id: 'Shared', type: 'string' } } },
        second: { ...ok, path: '/other', responses: { 200: { $id: 'Shared', type: 'integer' } } },
      },
      'both carry $id \'Shared\'',
    ],
  ])('refuses %s', (_label, contractUnderTest, mentions) => {
    expect(() => emit(contractUnderTest)).toThrow(mentions as string);
  });

  it.each([
    ['a router with no routes', {}],
    ['two routes producing one operationId', { cards: { activate: ok }, cardsActivate: ok }],
    ['a query schema that is not an object', { probe: { ...ok, query: { type: 'string' } } }],
  ])('says it cannot run rather than blaming a schema, for %s', (_label, contractUnderTest) => {
    // The wording is the assertion, not just the throw: a bare error escaping
    // from somewhere else would also satisfy `toThrow()`, and `gates.ts`
    // distinguishes "the gate is broken" from "the contract is unpublishable"
    // on exactly this prefix.
    expect(() => emit(contractUnderTest)).toThrow(/^emit gate cannot run: /);
    expect(() => emit(contractUnderTest)).not.toThrow(UnrepresentableSchemaError);
  });

  it('refuses a meta component that disagrees with a contract schema of the same $id', () => {
    const contractUnderTest = {
      probe: { ...ok, responses: { 200: { $id: 'Shared', type: 'string' } } },
    };
    const meta = {
      info: { title: 'probe', version: '0.1.0' },
      components: { schemas: { Shared: { type: 'integer' } } },
    };

    expect(() => emit(contractUnderTest, meta))
      .toThrow(/^emit gate cannot run: meta.components.schemas\['Shared'\]/);
  });

  it('checks a meta-supplied component the same way it checks a contract schema', () => {
    const meta = {
      info: { title: 'probe', version: '0.1.0' },
      components: { schemas: { Loose: Type.Any() } },
    };

    expect(() => emit({ probe: ok }, meta))
      .toThrow('emit gate cannot represent \'components.schemas.Loose\'');
  });

  it('resolves a contract $ref against a component meta supplied', () => {
    const meta = {
      info: { title: 'probe', version: '0.1.0' },
      components: { schemas: { Shared: { type: 'string', minLength: 1 } } },
    };
    const contractUnderTest = {
      probe: { ...ok, responses: { 200: { $ref: 'Shared' } } },
    };

    // The positive control for the two refusals above: the same mechanism,
    // used correctly, has to work — otherwise they pass because nothing
    // resolves at all.
    const document = emit(contractUnderTest, meta) as Record<string, unknown>;

    expect(at(document, 'paths./probe.get.responses.200.content.application/json.schema'))
      .toEqual({ $ref: '#/components/schemas/Shared' });
  });
});
