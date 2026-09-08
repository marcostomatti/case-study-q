/**
 * Runtime suite for `requestParsing.ts`.
 *
 * This module is the only thing standing between a consumer and spec section
 * 2.5's request half, because `@ts-rest/express` validates nothing when a
 * schema is TypeBox rather than zod. So the claims here are the ones that
 * would otherwise be enforced by nobody:
 *
 * - **An unknown field is refused**, in a query, in a body and in a path
 *   parameter container, and the refusal names it.
 * - **A declared scalar is coerced from its query string**, and only when the
 *   raw value is an exact literal of the declared type. Everything else stays
 *   a string and is refused, so nothing is quietly reinterpreted.
 * - **The published defaults are applied**, from the document rather than
 *   from a constant restated here.
 * - **The refusal is the contract's own `ErrorResponse`.** `tsc` pins the
 *   shape, so what is asserted here is what a type cannot say: the code comes
 *   from the published catalogue, the message is non-empty, and `fields` is
 *   absent rather than `[]`.
 * - **Every request schema the contract declares can actually be checked.**
 *   The last block walks all six request slots, because a schema TypeBox
 *   refuses to walk would turn one whole operation into a `500`.
 *
 * Two shapes recur, both for the reason the neighbouring mapper suites give.
 * A case asserting something was refused sits beside a positive control that
 * must still be accepted, or it passes equally against a parser that refuses
 * everything; and a case asserting a coercion happened sits beside one
 * asserting a near-miss did not, or it passes against a parser that coerces
 * anything numeric-looking.
 */
import type { ErrorResponse } from '@marcos-corp/contracts-service-a';
import type { ContractPlainType } from '@ts-rest/core';

import {
  contract,
  ERROR_CODES,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  requestObject,
} from '@marcos-corp/contracts-service-a';
import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import {
  isIssuedIdentifier,
  parseQueryParameters,
  parseRequestPayload,
  SCHEMA_NOT_CHECKABLE,
} from './requestParsing';

/** A legal identifier of the shape this provider issues. */
const ISSUED_ID = '11111111-1111-4111-8111-111111111111';

/** What the contract's defaults resolve an empty query to. */
const DEFAULTED_PAGE = { limit: PAGE_LIMIT_DEFAULT, offset: 0 };

/**
 * The failure of a parse, or a test failure naming what came back instead.
 *
 * A case that reads `outcome.error` off an accepted outcome would otherwise
 * read `undefined` and assert nothing.
 */
function refusalOf<Value_>(
  outcome: ReturnType<typeof parseRequestPayload<Value_>>,
): ErrorResponse {
  if (outcome.ok) {
    throw new Error(
      `expected the request to be refused, and it was accepted as ${JSON.stringify(outcome.value)}`,
    );
  }
  return outcome.error;
}

/** The accepted value, or a test failure carrying the refusal's own message. */
function acceptedOf<Value_>(
  outcome: ReturnType<typeof parseRequestPayload<Value_>>,
): Value_ {
  if (!outcome.ok) {
    throw new Error(`expected the request to be accepted, and it was refused: ${outcome.error.message}`);
  }
  return outcome.value;
}

/**
 * A schema slot as ts-rest types one, for the cases that need a shape the
 * contract does not happen to publish.
 *
 * The cast is the same one the module under test makes, in the same direction
 * the contract's own `contractSchema` makes it, and it is confined to this
 * helper so no case restates it.
 */
function slot<Schema>(schema: unknown): ContractPlainType<Schema> {
  return schema as ContractPlainType<Schema>;
}

describe('parseQueryParameters', () => {
  it('applies the defaults the contract publishes when the query is empty', () => {
    const outcome = parseQueryParameters(contract.listCompanies.query, {});

    expect(acceptedOf(outcome)).toStrictEqual(DEFAULTED_PAGE);
  });

  it('takes the published default from the document, not from a constant here', () => {
    // The control for the case above: if the provider restated `20`, this
    // would still pass while the document said something else. Reading the
    // schema is what ties the two together.
    const { properties } = JSON.parse(JSON.stringify(contract.listCompanies.query)) as {
      properties: { limit: { default: number }; offset: { default: number } };
    };

    expect(properties.limit.default).toBe(DEFAULTED_PAGE.limit);
    expect(properties.offset.default).toBe(DEFAULTED_PAGE.offset);
  });

  it('coerces a declared integer sent as an exact literal', () => {
    const outcome = parseQueryParameters(contract.listCompanies.query, {
      limit: '5',
      offset: '10',
    });

    expect(acceptedOf(outcome)).toStrictEqual({ limit: 5, offset: 10 });
  });

  it('does not coerce a decimal into a declared integer', () => {
    const refusal = refusalOf(parseQueryParameters(contract.listCompanies.query, {
      limit: '5.5',
    }));

    expect(refusal.fields).toStrictEqual(['limit']);
  });

  it('does not coerce a repeated parameter, which arrives as an array', () => {
    const refusal = refusalOf(parseQueryParameters(contract.listCompanies.query, {
      limit: ['1', '2'],
    }));

    expect(refusal.fields).toStrictEqual(['limit']);
  });

  it('does not coerce a bracketed parameter, which arrives as an object', () => {
    const refusal = refusalOf(parseQueryParameters(contract.listCompanies.query, {
      limit: { a: '1' },
    }));

    expect(refusal.fields).toStrictEqual(['limit']);
  });

  it('rejects an unknown query field and names it', () => {
    const refusal = refusalOf(parseQueryParameters(contract.listCompanies.query, {
      limit: '5',
      bogus: '1',
    }));

    expect(refusal.code).toBe('validation_failed');
    expect(refusal.fields).toStrictEqual(['bogus']);
    expect(refusal.message).toContain('bogus');
  });

  it('never coerces a key the schema does not declare', () => {
    // The point of the case above is that an undeclared key cannot be turned
    // into something that looks declared on its way to the check. The refusal
    // has to be about the key, not about its value's type.
    const refusal = refusalOf(parseQueryParameters(contract.listCompanies.query, {
      bogus: '1',
    }));

    expect(refusal.message).toContain('Unexpected property');
  });

  it('enforces the ceiling the contract publishes', () => {
    const refusal = refusalOf(parseQueryParameters(contract.listCompanies.query, {
      limit: String(PAGE_LIMIT_MAX + 1),
    }));

    expect(refusal.fields).toStrictEqual(['limit']);
  });

  it('accepts the ceiling itself', () => {
    // The positive control for the case above: without it, a parser that
    // rejected every limit would pass.
    const outcome = parseQueryParameters(contract.listCompanies.query, {
      limit: String(PAGE_LIMIT_MAX),
    });

    expect(acceptedOf(outcome)).toStrictEqual({ limit: PAGE_LIMIT_MAX, offset: 0 });
  });

  it('coerces a declared number, but only from an exact decimal literal', () => {
    const measurement = slot<{ ratio?: number }>(
      requestObject({ ratio: Type.Optional(Type.Number()) }),
    );

    expect(acceptedOf(parseQueryParameters(measurement, { ratio: '1.5' })))
      .toStrictEqual({ ratio: 1.5 });
    expect(refusalOf(parseQueryParameters(measurement, { ratio: '1.5e3' })).fields)
      .toStrictEqual(['ratio']);
  });

  it('coerces a declared boolean from its two literals and nothing else', () => {
    const flag = slot<{ settled?: boolean }>(
      requestObject({ settled: Type.Optional(Type.Boolean()) }),
    );

    expect(acceptedOf(parseQueryParameters(flag, { settled: 'false' })))
      .toStrictEqual({ settled: false });
    expect(refusalOf(parseQueryParameters(flag, { settled: 'yes' })).fields)
      .toStrictEqual(['settled']);
  });

  it('leaves the caller\'s object untouched', () => {
    // `Value.Default` mutates what it is handed, and `req.query` is Express's
    // own object, which the usage logger and any later middleware also read.
    const raw = { limit: '5' };

    parseQueryParameters(contract.listCompanies.query, raw);

    expect(raw).toStrictEqual({ limit: '5' });
  });
});

describe('parseRequestPayload', () => {
  it('accepts a body the contract declares', () => {
    const outcome = parseRequestPayload(contract.activateCard.body, {
      confirmedLastFour: '4321',
    });

    expect(acceptedOf(outcome)).toStrictEqual({ confirmedLastFour: '4321' });
  });

  it('rejects an unknown body field and names it', () => {
    const refusal = refusalOf(parseRequestPayload(contract.activateCard.body, {
      confirmedLastFour: '4321',
      extra: true,
    }));

    expect(refusal.code).toBe('validation_failed');
    expect(refusal.fields).toStrictEqual(['extra']);
  });

  it('rejects a missing required body field, reporting it once', () => {
    // TypeBox reports a missing required property twice — as missing and as
    // the wrong type. A consumer reading two sentences about one field learns
    // nothing from the second.
    const refusal = refusalOf(parseRequestPayload(contract.activateCard.body, {}));

    expect(refusal.fields).toStrictEqual(['confirmedLastFour']);
    expect(refusal.message.split(';')).toHaveLength(1);
  });

  it('rejects a body that is not an object at all, naming no field', () => {
    // `express.json()` hands over an array verbatim for a `[1,2]` payload, and
    // the complaint is about the payload rather than any field in it — so
    // `fields` is absent, never `[]` (spec section 2.5's one spelling of
    // empty).
    const refusal = refusalOf(parseRequestPayload(contract.activateCard.body, [1, 2]));

    expect(refusal.fields).toBeUndefined();
    expect('fields' in refusal).toBe(false);
  });

  it('rejects a path parameter that violates the contract\'s bounds', () => {
    const refusal = refusalOf(parseRequestPayload(
      contract.getCompanyDashboard.pathParams,
      { companyId: '' },
    ));

    expect(refusal.fields).toStrictEqual(['companyId']);
  });

  it('accepts a path parameter inside them', () => {
    const outcome = parseRequestPayload(
      contract.getCompanyDashboard.pathParams,
      { companyId: ISSUED_ID },
    );

    expect(acceptedOf(outcome)).toStrictEqual({ companyId: ISSUED_ID });
  });

  it('names a nested field with its array position, as the contract spells one', () => {
    const nested = slot<{ lines: { amount: number }[] }>(
      requestObject({
        lines: Type.Array(requestObject({ amount: Type.Integer() })),
      }),
    );

    const refusal = refusalOf(parseRequestPayload(nested, {
      lines: [{ amount: 1 }, { amount: 'x' }],
    }));

    expect(refusal.fields).toStrictEqual(['lines.1.amount']);
  });

  it('bounds how many fields one refusal names, and counts the rest', () => {
    const wide = slot<Record<string, never>>(requestObject({}));
    const unknowns = Object.fromEntries(
      Array.from({ length: 12 }, (_value, index) => [`unknown${String(index)}`, 1]),
    );

    const refusal = refusalOf(parseRequestPayload(wide, unknowns));

    expect(refusal.fields).toHaveLength(10);
    expect(refusal.message).toContain('2 further problems were not reported');
  });
});

describe('every refusal is the contract\'s own error payload', () => {
  /**
   * Built per case rather than once at module scope.
   *
   * `refusalOf` throws when a request it expected to be refused is accepted,
   * and a throw out there makes every case in this **file** vanish rather than
   * one go red — which reads as "the suite is broken" instead of "the parser
   * stopped refusing". Measured: a mutation that stripped unknown query keys
   * reported `Tests no tests` for the whole file.
   */
  function refusals(): ErrorResponse[] {
    return [
      refusalOf(parseQueryParameters(contract.listCompanies.query, { bogus: 1 })),
      refusalOf(parseRequestPayload(contract.activateCard.body, {})),
      refusalOf(parseRequestPayload(contract.activateCard.body, 'not an object')),
      refusalOf(parseRequestPayload(
        contract.getCompanyDashboard.pathParams,
        { companyId: '' },
      )),
    ];
  }

  it('has something to check', () => {
    // The control for every loop below: an empty list satisfies all of them.
    expect(refusals()).not.toHaveLength(0);
  });

  // `tsc` already pins the *shape* of each refusal against `ErrorResponse`'s
  // static type, which is stronger than any runtime check of the same thing.
  // What it cannot pin is the value constraints the schema states beyond the
  // type, so those are what the three cases below assert — and `code` is read
  // off the published catalogue rather than restated, so a member added or
  // removed there moves this check with it.
  //
  // `Value.Check(ErrorResponse, ...)` is deliberately not used: it throws
  // `Unknown type`, because `ErrorResponse.code` is a `Type.Unsafe` enum and
  // TypeBox attaches no kind to one. See the module header.
  it('carries a code from the published catalogue', () => {
    for (const refusal of refusals()) {
      expect(ERROR_CODES).toContain(refusal.code);
    }
  });

  it('carries a non-empty message, as the schema\'s minLength requires', () => {
    for (const refusal of refusals()) {
      expect(refusal.message.length).toBeGreaterThan(0);
    }
  });

  it('never emits an empty fields array', () => {
    // `minItems: 1` in the schema, and spec section 2.5's single spelling of
    // empty: absent. An empty array would be a second one.
    for (const refusal of refusals()) {
      expect(refusal.fields).not.toStrictEqual([]);
    }
  });
});

describe('every request schema this contract declares can actually be checked', () => {
  /** Every request slot of every operation, named so a failure says which. */
  const requestSlots = Object.entries(contract).flatMap(([operationId, route]) => [
    ...'pathParams' in route
      ? [[`${operationId}.pathParams`, route.pathParams] as const]
      : [],
    ...'query' in route
      ? [[`${operationId}.query`, route.query] as const]
      : [],
    ...'body' in route
      ? [[`${operationId}.body`, route.body] as const]
      : [],
  ]);

  it('found the slots to check', () => {
    // Without this the loop below passes against a filter that matched
    // nothing, which is exactly how this guard would stop guarding.
    expect(requestSlots.map(([name]) => name)).toStrictEqual([
      'listCompanies.query',
      'getCompanyDashboard.pathParams',
      'listCompanyTransactions.pathParams',
      'listCompanyTransactions.query',
      'activateCard.pathParams',
      'activateCard.body',
    ]);
  });

  it.each(requestSlots)('checks %s without refusing to run', (_name, schemaSlot) => {
    // A `Type.Unsafe` enum anywhere in a request schema makes TypeBox throw
    // rather than answer, so this operation would answer every request with a
    // `500`. The day one is added, this fails instead of production.
    expect(() => parseRequestPayload(slot(schemaSlot), {})).not.toThrow();
  });

  it('reports an uncheckable schema as the provider\'s failure, not the caller\'s', () => {
    // The positive control for the guard above: it is only worth having if an
    // uncheckable schema really does reach the pointed throw.
    const withUnsafeEnum = slot<{ state: string }>(
      requestObject({ state: Type.Unsafe<string>({ type: 'string', enum: ['a', 'unknown'] }) }),
    );

    expect(() => parseRequestPayload(withUnsafeEnum, { state: 'a' }))
      .toThrow(SCHEMA_NOT_CHECKABLE);
  });
});

describe('isIssuedIdentifier', () => {
  it('accepts an identifier of the shape this provider issues', () => {
    expect(isIssuedIdentifier(ISSUED_ID)).toBe(true);
  });

  it('accepts the seeded identifiers, so the demo is not refused by its own guard', () => {
    expect(isIssuedIdentifier('22222222-2222-4222-8222-222222222222')).toBe(true);
  });

  it.each([
    ['a shape no key scheme here produces', 'not-a-uuid'],
    ['an empty string', ''],
    ['a truncated identifier', '11111111-1111-4111-8111-11111111111'],
    ['an over-long identifier', '11111111-1111-4111-8111-1111111111111'],
    ['a non-hexadecimal character', '1111111g-1111-4111-8111-111111111111'],
    ['a SQL fragment', '1\' OR \'1\'=\'1'],
  ])('refuses %s', (_label, candidate) => {
    expect(isIssuedIdentifier(candidate)).toBe(false);
  });
});
