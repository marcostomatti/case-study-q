import type { ContractObjectOptions } from './shared';
import type { TSchema } from '@sinclair/typebox';

import { describe, expect, it } from 'vitest';

import {
  CurrencyCode,
  MonetaryAmount,
  PageInfo,
  PaginationQuery,
  paginatedResponse,
  requestObject,
  responseObject,
  Timestamp,
} from './shared';

/**
 * What this file pins that `shared.test-d.ts` cannot: the JSON these schemas
 * publish. A `Static<>` type says nothing about a `pattern`, a `minimum`, a
 * `default`, an `$id` or an `additionalProperties`, and those are the whole of
 * what a consumer, a mock server and `oasdiff` read.
 *
 * Every assertion is over `JSON.parse(JSON.stringify(schema))` rather than over
 * the schema object. TypeBox attaches its own `Kind` symbols, which no gate in
 * this repo ever sees; the JSON round trip is exactly the reduction
 * `emitOpenApi` writes into the document.
 *
 * Gate 2 makes the house-rule claim about the *emitted document*, once there is
 * a contract to emit. These cases make it about the schemas themselves, which
 * is where the fix goes when it fails.
 */
const emitted = (schema: TSchema): Record<string, unknown> => JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/**
 * Every node carrying `type: 'object'` reachable from a schema, paired with the
 * path that reached it.
 *
 * Recursion is by keyword — `properties` and `items`, the two these schemas
 * use — rather than by walking every object found. A generic walk descends into
 * `default` and `examples`, which hold values, and a value is free to look
 * exactly like a schema.
 */
function objectNodes(
  schema: unknown,
  path: string,
): Array<[string, Record<string, unknown>]> {
  if (!isRecord(schema)) return [];

  const here: Array<[string, Record<string, unknown>]> = schema['type'] === 'object'
    ? [[path, schema]]
    : [];
  const properties = isRecord(schema['properties'])
    ? Object.entries(schema['properties'])
    : [];

  return [
    ...here,
    ...properties.flatMap(([name, value]) => objectNodes(value, `${path}.properties.${name}`)),
    ...objectNodes(schema['items'], `${path}.items`),
  ];
}

describe('the object builders', () => {
  it('has responseObject tolerate unknown fields, per spec §2.5', () => {
    expect(emitted(responseObject({}))['additionalProperties']).toBe(true);
  });

  it('has requestObject reject unknown fields, per spec §2.5', () => {
    expect(emitted(requestObject({}))['additionalProperties']).toBe(false);
  });

  it('lets neither be reversed by a caller-supplied option', () => {
    // `ContractObjectOptions` omits the key, so this is a `check-types` failure
    // as well — the cast is what lets the runtime half of that claim be made.
    // Without it the spread order in the builders is untested, and a builder
    // written `{ additionalProperties: x, ...options }` passes every other case
    // in this file.
    const tolerate = { additionalProperties: true } as unknown as ContractObjectOptions;
    const reject = { additionalProperties: false } as unknown as ContractObjectOptions;

    expect(emitted(responseObject({}, reject))['additionalProperties']).toBe(true);
    expect(emitted(requestObject({}, tolerate))['additionalProperties']).toBe(false);
  });

  it('carries every other option through untouched', () => {
    expect(emitted(responseObject({}, { $id: 'Probe', description: 'probe' }))).toEqual({
      $id: 'Probe',
      description: 'probe',
      additionalProperties: true,
      type: 'object',
      properties: {},
    });
  });
});

describe('the shared primitives', () => {
  it('publishes a currency as an ISO-4217 pattern rather than an enum', () => {
    // An enum here would drag house rule 3's `unknown` member into a published
    // external standard. See the schema's own note.
    expect(emitted(CurrencyCode)).toEqual({
      description: 'ISO-4217 alphabetic currency code, uppercase.',
      pattern: '^[A-Z]{3}$',
      minLength: 3,
      maxLength: 3,
      examples: ['SEK'],
      type: 'string',
    });
  });

  it('publishes money as signed integer minor units paired with a currency', () => {
    // `type: 'integer'` and no `maximum` are both load-bearing: a `number`
    // would let a float through, and a ceiling would publish the width of the
    // column behind it.
    expect(emitted(MonetaryAmount)).toEqual({
      $id: 'MonetaryAmount',
      description: 'An amount of money as an integer count of a currency\'s minor unit.',
      additionalProperties: true,
      type: 'object',
      required: ['minorUnits', 'currency'],
      properties: {
        minorUnits: {
          description: 'Signed amount in the currency\'s minor unit. 5 400 kr is 540000.',
          examples: [540000],
          type: 'integer',
        },
        currency: emitted(CurrencyCode),
      },
    });
  });

  it('publishes an instant as an ISO-8601 string, never an epoch number', () => {
    expect(emitted(Timestamp)).toEqual({
      description: 'An instant, ISO-8601 with an explicit offset.',
      format: 'date-time',
      examples: ['2026-09-08T07:41:00Z'],
      type: 'string',
    });
  });

  it('publishes page position as limit, offset and total, with no derived hasMore', () => {
    expect(emitted(PageInfo)).toEqual({
      $id: 'PageInfo',
      description: 'Where a page sits in the collection it was taken from.',
      additionalProperties: true,
      type: 'object',
      required: ['limit', 'offset', 'total'],
      properties: {
        limit: {
          description: 'Page size the provider applied, which may be the default.',
          minimum: 1,
          maximum: 100,
          examples: [20],
          type: 'integer',
        },
        offset: {
          description: 'Number of items skipped before this page.',
          minimum: 0,
          examples: [0],
          type: 'integer',
        },
        total: {
          description: 'Total items matching the query, across every page.',
          minimum: 0,
          examples: [57],
          type: 'integer',
        },
      },
    });
  });

  it('states the paging defaults in the document rather than in a rejection', () => {
    expect(emitted(PaginationQuery)).toEqual({
      description: 'Offset paging parameters.',
      additionalProperties: false,
      type: 'object',
      properties: {
        limit: {
          description: 'Page size to return.',
          minimum: 1,
          maximum: 100,
          default: 20,
          type: 'integer',
        },
        offset: {
          description: 'Number of items to skip before the page.',
          minimum: 0,
          default: 0,
          type: 'integer',
        },
      },
    });
    // All optional, so TypeBox emits no `required` at all. Stated separately
    // because an absent key and an empty list are different documents.
    expect(emitted(PaginationQuery)['required']).toBeUndefined();
  });

  it('wraps a list in an envelope carrying the shared page position', () => {
    expect(emitted(paginatedResponse(CurrencyCode, { $id: 'CurrencyPage' }))).toEqual({
      $id: 'CurrencyPage',
      additionalProperties: true,
      type: 'object',
      required: ['items', 'page'],
      properties: {
        items: {
          description: 'The items on this page.',
          type: 'array',
          items: emitted(CurrencyCode),
        },
        page: emitted(PageInfo),
      },
    });
  });

  it('leaves the envelope unnamed when no $id is asked for', () => {
    // An inlined envelope is a legitimate choice for a one-off list; a
    // component nothing references is not.
    expect(emitted(paginatedResponse(CurrencyCode))['$id']).toBeUndefined();
  });

  it('names only the objects reused across operations', () => {
    // `$id` is what makes `emitOpenApi` hoist a schema into
    // `components.schemas` and leave a `$ref`. Scalars stay inline so the
    // constraint reads at the field it constrains; `PaginationQuery` stays
    // inline because a query container is exploded into `parameters` and a
    // component for it would be referenced by nothing.
    expect({
      CurrencyCode: emitted(CurrencyCode)['$id'],
      Timestamp: emitted(Timestamp)['$id'],
      MonetaryAmount: emitted(MonetaryAmount)['$id'],
      PageInfo: emitted(PageInfo)['$id'],
      PaginationQuery: emitted(PaginationQuery)['$id'],
    }).toEqual({
      CurrencyCode: undefined,
      Timestamp: undefined,
      MonetaryAmount: 'MonetaryAmount',
      PageInfo: 'PageInfo',
      PaginationQuery: undefined,
    });
  });

  it('sets additionalProperties explicitly on every object node it publishes', () => {
    // House rule 2, asserted here rather than only through gate 2: the path
    // list is what makes it non-vacuous. A walk that stopped at the root would
    // report a shorter list rather than a green pass.
    const nodes = [
      ...objectNodes(emitted(CurrencyCode), 'CurrencyCode'),
      ...objectNodes(emitted(Timestamp), 'Timestamp'),
      ...objectNodes(emitted(MonetaryAmount), 'MonetaryAmount'),
      ...objectNodes(emitted(PageInfo), 'PageInfo'),
      ...objectNodes(emitted(PaginationQuery), 'PaginationQuery'),
      ...objectNodes(emitted(paginatedResponse(MonetaryAmount)), 'paginatedResponse'),
    ];

    expect(nodes.map(([path, node]) => [path, node['additionalProperties']])).toEqual([
      ['MonetaryAmount', true],
      ['PageInfo', true],
      ['PaginationQuery', false],
      ['paginatedResponse', true],
      ['paginatedResponse.properties.items.items', true],
      ['paginatedResponse.properties.page', true],
    ]);
  });
});
