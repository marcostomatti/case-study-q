import type { TSchema } from '@sinclair/typebox';
import type { AppRoute } from '@ts-rest/core';

import { describe, expect, it } from 'vitest';

import { contract, DueInvoice } from './contract';
import { ErrorResponse } from './schemas/error';
import { Invoice } from './schemas/invoice';

/**
 * What this file pins that `contract.test-d.ts` cannot: that every schema slot
 * in the router holds the **runtime** TypeBox object rather than a compile-time
 * marker, which statuses the operation publishes, and the direction
 * `additionalProperties` points in on each side of a request.
 *
 * The identity assertions are the point of the file. `c.type<DueInvoice>()`
 * type-checks everywhere the real schema does and is `Symbol(ContractPlainType)`
 * at runtime, so a contract built out of it satisfies every type-level case
 * while publishing nothing — see the header of `./contract`. `toBe` against the
 * exported schema is the only assertion that separates the two.
 *
 * See `schemas/shared.test.ts` for why the shape assertions go through the JSON
 * round trip rather than over the TypeBox object.
 */
const emitted = (schema: TSchema): Record<string, unknown> => JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;

/** The routes, paired with the router key that is also their `operationId`. */
const routes = Object.entries(contract) as [string, AppRoute][];

/** The status keys an operation publishes, as sorted strings. */
const statuses = (route: AppRoute): string[] => Object.keys(route.responses).sort();

describe('the router as a whole', () => {
  it('publishes exactly the one operation the banner needs', () => {
    // The key is the operationId: `emitOpenApi` derives one from the keys that
    // reach a route, so this is also the id `api_usage` records under spec
    // §2.3. One operation is what proves provider-as-consumer; a second would
    // be more contract, not more evidence.
    expect(routes.map(([key]) => key)).toEqual(['getCompanyDueInvoice']);
  });

  it('addresses the invoice through the company that scopes it', () => {
    expect(routes.map(([key, route]) => `${key}: ${route.method} ${route.path}`)).toEqual([
      'getCompanyDueInvoice: GET /companies/:companyId/due-invoice',
    ]);
  });

  it('names one resource rather than selecting from a collection', () => {
    // `/invoices/due` reads better right up until an `/invoices/:invoiceId`
    // operation lands beside it, at which point `due` competes with every real
    // identifier.
    expect(contract.getCompanyDueInvoice.path).not.toContain('/invoices/');
  });

  it('declares a path parameter for every variable in its own path, and no other', () => {
    // `emitOpenApi` refuses a template and a `pathParams` schema that disagree,
    // but it refuses it against the emitted document, a task downstream.
    // Comparing the two readings here names the route instead.
    const fromPath = Object.fromEntries(routes.map(([key, route]) => [
      key,
      [...route.path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1]).sort(),
    ]));
    const fromSchema = Object.fromEntries(routes.map(([key, route]) => [
      key,
      Object.keys((route.pathParams === undefined
        ? {}
        : emitted(route.pathParams as TSchema)['properties'] ?? {}) as Record<string, unknown>).sort(),
    ]));

    expect(fromSchema).toEqual(fromPath);
    expect(fromPath).toEqual({ getCompanyDueInvoice: ['companyId'] });
  });

  it('makes every path parameter required, since a URL cannot be built without it', () => {
    for (const [key, route] of routes) {
      if (route.pathParams === undefined) continue;
      const container = emitted(route.pathParams as TSchema);
      const properties = Object.keys(container['properties'] as Record<string, unknown>);

      expect(`${key}: ${(container['required'] as string[]).slice().sort()
        .join(',')}`)
        .toBe(`${key}: ${properties.slice().sort()
          .join(',')}`);
    }
  });

  it('takes no request body and no query, since it reads one thing', () => {
    // The inverting half of the cases above: every one of them states that a
    // declared slot reaches the document, and none would notice a slot
    // appearing that this operation has no use for.
    expect(contract.getCompanyDueInvoice.body).toBeUndefined();
    expect(contract.getCompanyDueInvoice.query).toBeUndefined();
  });
});

describe('the schema slots hold runtime schemas, not compile-time markers', () => {
  // Each case is `toBe`, not `toEqual`: a structural copy would satisfy
  // equality and would then drift from the schema it was copied from, and
  // `c.type<T>()` would satisfy neither but type-check identically.
  it('binds the success response to the envelope this module owns', () => {
    expect(contract.getCompanyDueInvoice.responses[200]).toBe(DueInvoice);
  });

  it('binds every error response to the one shared payload', () => {
    for (const status of [400, 401, 404, 500] as const) {
      expect(contract.getCompanyDueInvoice.responses[status]).toBe(ErrorResponse);
    }
  });

  it('leaves each schema a TypeBox schema rather than a symbol', () => {
    // The failure this rules out is the one ts-rest's own documentation
    // recommends: `c.type<T>()` is `Symbol(ContractPlainType)` at runtime, and
    // a contract built from it emits an operation stating nothing.
    for (const [key, route] of routes) {
      for (const [status, schema] of Object.entries(route.responses)) {
        expect(`${key}.${status}: ${typeof schema}`).toBe(`${key}.${status}: object`);
        expect(emitted(schema as TSchema)).toHaveProperty('type');
      }

      expect(typeof route.pathParams).toBe('object');
      expect(emitted(route.pathParams as TSchema)).toHaveProperty('type');
    }
  });
});

describe('the error responses', () => {
  it('gives the operation the identity and provider-failure statuses', () => {
    expect(statuses(contract.getCompanyDueInvoice)).toContain('401');
    expect(statuses(contract.getCompanyDueInvoice)).toContain('500');
  });

  it('publishes exactly the failures this operation can actually have', () => {
    // `400` because it takes a path parameter a consumer can get wrong, `404`
    // because it addresses a company that may not exist. No `409`: nothing here
    // can be in the wrong state.
    expect(statuses(contract.getCompanyDueInvoice)).toEqual(['200', '400', '401', '404', '500']);
  });

  it('publishes no 403, since not-yours folds onto not-found', () => {
    // Distinguishing them tells an unauthorised caller which identifiers are
    // real.
    expect(statuses(contract.getCompanyDueInvoice)).not.toContain('403');
  });

  it('publishes no status naming the upstream this provider depends on', () => {
    // Which services `service-b` calls is a deployment fact, not an API
    // promise. See `schemas/error.ts` for the same argument on the catalogue.
    expect(statuses(contract.getCompanyDueInvoice)).not.toContain('502');
    expect(statuses(contract.getCompanyDueInvoice)).not.toContain('503');
  });

  it('declares no Authorization header parameter', () => {
    // OpenAPI states a header parameter with that name SHALL be ignored, so
    // declaring one publishes a requirement no tool reads — worse than
    // declaring nothing, because it looks covered. The credential lives in the
    // emitted document's `securitySchemes`; what the contract states about spec
    // §2.3 is the `401`.
    expect(contract.getCompanyDueInvoice.headers).toBeUndefined();
  });
});

describe('the due-invoice envelope', () => {
  it('carries the invoice as an optional field, not as the whole body', () => {
    // A company owing nothing is the ordinary case rather than a failure.
    // `404` already means "no such company, or not yours to see", and
    // overloading it would make a screen without a banner indistinguishable
    // from a caller asking about a company it cannot see.
    expect(emitted(DueInvoice)).toEqual({
      $id: 'DueInvoice',
      description: 'The invoice a company still owes. Absent when it owes nothing.',
      type: 'object',
      additionalProperties: true,
      properties: { invoice: emitted(Invoice) },
    });
  });

  it('states no required list at all, since its only field is optional', () => {
    // TypeBox emits no `required` key rather than an empty array, and an absent
    // key and an empty list are different documents.
    expect(emitted(DueInvoice)).not.toHaveProperty('required');
  });

  it('reuses the invoice component rather than inlining a copy', () => {
    expect(contract.getCompanyDueInvoice.responses[200]).toBe(DueInvoice);
    expect((emitted(DueInvoice)['properties'] as Record<string, Record<string, unknown>>)['invoice']?.['$id'])
      .toBe('Invoice');
  });

  it('tolerates unknown fields, so an added sibling is not a consumer failure', () => {
    expect(emitted(DueInvoice)['additionalProperties']).toBe(true);
  });
});

describe('the request direction', () => {
  it('rejects unknown fields in the path-parameter container', () => {
    // The strict half of spec §2.5. `emitOpenApi` explodes this container into
    // `parameters`, so the strictness never reaches the document and becomes
    // the provider's to enforce — but the schema is what it enforces against.
    expect(emitted(contract.getCompanyDueInvoice.pathParams as TSchema)['additionalProperties'])
      .toBe(false);
  });

  it('tolerates unknown fields in every response it publishes', () => {
    for (const schema of Object.values(contract.getCompanyDueInvoice.responses)) {
      expect(emitted(schema as TSchema)['additionalProperties']).toBe(true);
    }
  });
});
