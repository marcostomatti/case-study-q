import type { TSchema } from '@sinclair/typebox';
import type { AppRoute } from '@ts-rest/core';

import { describe, expect, it } from 'vitest';

import {
  ActivateCardRequest,
  CompanyList,
  contract,
  TransactionList,
} from './contract';
import { Card, CardId } from './schemas/card';
import { CompanyId, CompanySummary } from './schemas/company';
import { Dashboard } from './schemas/dashboard';
import { ErrorResponse } from './schemas/error';
import { PageInfo, PaginationQuery } from './schemas/shared';
import { Transaction } from './schemas/transaction';

/**
 * What this file pins that `contract.test-d.ts` cannot: that every schema slot
 * in the router holds the **runtime** TypeBox object rather than a compile-time
 * marker, which statuses each operation publishes, and the direction
 * `additionalProperties` points in on each side of a request.
 *
 * The identity assertions are the point of the file. `c.type<Dashboard>()`
 * type-checks everywhere the real schema does and is `Symbol(ContractPlainType)`
 * at runtime, so a contract built out of it satisfies every type-level case
 * while publishing nothing — see the header of `./contract`. `toBe` against the
 * exported schema is the only assertion that separates the two.
 *
 * See `shared.test.ts` for why the shape assertions go through the JSON round
 * trip rather than over the TypeBox object.
 */
const emitted = (schema: TSchema): Record<string, unknown> => JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;

/** The routes, paired with the router key that is also their `operationId`. */
const routes = Object.entries(contract) as [string, AppRoute][];

/** The status keys an operation publishes, as sorted strings. */
const statuses = (route: AppRoute): string[] => Object.keys(route.responses).sort();

describe('the router as a whole', () => {
  it('publishes exactly the four operations the mobile view needs', () => {
    // The keys are the operationIds: `emitOpenApi` derives one from the keys
    // that reach a route, so this list is also the set of ids `api_usage`
    // records under spec section 2.3.
    expect(routes.map(([key]) => key)).toEqual([
      'listCompanies',
      'getCompanyDashboard',
      'listCompanyTransactions',
      'activateCard',
    ]);
  });

  it('addresses everything through the company that scopes it', () => {
    expect(routes.map(([key, route]) => `${key}: ${route.method} ${route.path}`)).toEqual([
      'listCompanies: GET /companies',
      'getCompanyDashboard: GET /companies/:companyId/dashboard',
      'listCompanyTransactions: GET /companies/:companyId/transactions',
      'activateCard: POST /companies/:companyId/cards/:cardId/activation',
    ]);
  });

  it('declares a path parameter for every variable in its own path, and no other', () => {
    // `emitOpenApi` refuses a template and a `pathParams` schema that disagree,
    // but it refuses it against the emitted document, several tasks downstream.
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
    // `listCompanies` addresses nothing, so it must declare no container at
    // all rather than an empty one — the inverting half of the comparison
    // above, which an empty object would also satisfy.
    expect(contract.listCompanies.pathParams).toBeUndefined();
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
});

describe('the schema slots hold runtime schemas, not compile-time markers', () => {
  // Each case is `toBe`, not `toEqual`: a structural copy would satisfy
  // equality and would then drift from the schema it was copied from, and
  // `c.type<T>()` would satisfy neither but type-check identically.
  it('binds each success response to the schema module that owns it', () => {
    expect(contract.listCompanies.responses[200]).toBe(CompanyList);
    expect(contract.getCompanyDashboard.responses[200]).toBe(Dashboard);
    expect(contract.listCompanyTransactions.responses[200]).toBe(TransactionList);
    expect(contract.activateCard.responses[200]).toBe(Card);
  });

  it('binds the activation body and every query container to their schemas', () => {
    expect(contract.activateCard.body).toBe(ActivateCardRequest);
    expect(contract.listCompanies.query).toBe(PaginationQuery);
    expect(contract.listCompanyTransactions.query).toBe(PaginationQuery);
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
    }
  });
});

describe('the error responses', () => {
  it('gives every operation the identity and provider-failure statuses', () => {
    // Declared once as `commonResponses` and merged into every route by
    // ts-rest, so an operation added later cannot be published without them.
    for (const [key, route] of routes) {
      expect(`${key}: ${statuses(route).includes('401')}`).toBe(`${key}: true`);
      expect(`${key}: ${statuses(route).includes('500')}`).toBe(`${key}: true`);
    }
  });

  it('publishes exactly the failures each operation can actually have', () => {
    // Asserted as the whole set rather than as a list of absences: a `403` or a
    // `429` added later reddens this case, where a `not.toContain` per status
    // could only catch the ones somebody thought to name. There is no `403`
    // because the catalogue folds "not yours to see" onto `not_found`, and no
    // `429` because the catalogue has no code a consumer could branch on.
    expect(Object.fromEntries(routes.map(([key, route]) => [key, statuses(route)]))).toEqual({
      listCompanies: ['200', '400', '401', '500'],
      getCompanyDashboard: ['200', '400', '401', '404', '500'],
      listCompanyTransactions: ['200', '400', '401', '404', '500'],
      activateCard: ['200', '400', '401', '404', '409', '500'],
    });
  });

  it('answers every failure with the one shared error schema', () => {
    // House rule 5 checks this against the emitted document. Here it is checked
    // by identity, which the document cannot express: two structurally equal
    // error schemas emit the same `$ref` only because they hoist under the same
    // `$id`, and that collision is an emit failure rather than a lint one.
    for (const [key, route] of routes) {
      for (const status of statuses(route).filter((code) => code.startsWith('4') || code.startsWith('5'))) {
        expect(`${key}.${status}`).toBe(`${key}.${status}`);
        expect(route.responses[Number(status)]).toBe(ErrorResponse);
      }
    }
  });
});

describe('the request/response asymmetry of spec section 2.5', () => {
  it('rejects unknown fields on everything a consumer sends', () => {
    expect(emitted(PaginationQuery)['additionalProperties']).toBe(false);
    expect(emitted(ActivateCardRequest)['additionalProperties']).toBe(false);
    for (const [key, route] of routes) {
      if (route.pathParams === undefined) continue;
      expect(`${key}: ${emitted(route.pathParams as TSchema)['additionalProperties']}`)
        .toBe(`${key}: false`);
    }
  });

  it('tolerates unknown fields on everything a consumer reads', () => {
    // A consumer validating against its own pinned version routinely sees
    // fields that version predates, and the additive change is the one the
    // diff gate lets through unreviewed.
    for (const [key, route] of routes) {
      for (const [status, schema] of Object.entries(route.responses)) {
        expect(`${key}.${status}: ${emitted(schema as TSchema)['additionalProperties']}`)
          .toBe(`${key}.${status}: true`);
      }
    }
  });
});

describe('the list envelopes', () => {
  it('publishes the companies page as a named component over the shared envelope', () => {
    expect(emitted(CompanyList)).toEqual({
      $id: 'CompanyList',
      description: 'A page of the companies the caller may act for.',
      additionalProperties: true,
      type: 'object',
      required: ['items', 'page'],
      properties: {
        items: { type: 'array', description: 'The items on this page.', items: emitted(CompanySummary) },
        page: emitted(PageInfo),
      },
    });
  });

  it('publishes the transactions page over the same envelope and a different item', () => {
    expect(emitted(TransactionList)).toEqual({
      $id: 'TransactionList',
      description: 'A page of one company\'s transactions, newest first.',
      additionalProperties: true,
      type: 'object',
      required: ['items', 'page'],
      properties: {
        items: { type: 'array', description: 'The items on this page.', items: emitted(Transaction) },
        page: emitted(PageInfo),
      },
    });
  });

  it('reuses the shared page component rather than restating the figures', () => {
    // The surviving `$id` is what says these are the shared shape rather than
    // two structurally similar copies that can drift. What `PageInfo` itself
    // states is `shared.test.ts`'s claim.
    const pageOf = (schema: TSchema): unknown => (
      (emitted(schema)['properties'] as Record<string, Record<string, unknown>>)['page']?.['$id']
    );

    expect(pageOf(CompanyList)).toBe('PageInfo');
    expect(pageOf(TransactionList)).toBe('PageInfo');
  });
});

describe('the activation request body', () => {
  it('asks for the four digits the cardholder can read off the card', () => {
    expect(emitted(ActivateCardRequest)).toEqual({
      $id: 'ActivateCardRequest',
      description: 'Confirmation that the cardholder is holding the card.',
      additionalProperties: false,
      type: 'object',
      required: ['confirmedLastFour'],
      properties: {
        confirmedLastFour: {
          type: 'string',
          description:
            'The last four digits printed on the physical card, as the cardholder reads them '
            + 'off it.',
          pattern: '^[0-9]{4}$',
          minLength: 4,
          maxLength: 4,
          examples: ['4321'],
        },
      },
    });
  });

  it('constrains the confirmation exactly as the card publishes the digits', () => {
    // The two schemas are separate on purpose — a request constraint and a
    // response constraint are separately versioned — but they describe the same
    // four digits, so a drift between them is a bug rather than a decision.
    // Stating the agreement here is what makes that drift a failing test.
    const confirmation = (emitted(ActivateCardRequest)['properties'] as Record<string, Record<string, unknown>>)['confirmedLastFour'];
    const published = (emitted(Card)['properties'] as Record<string, Record<string, unknown>>)['lastFour'];

    for (const keyword of ['type', 'pattern', 'minLength', 'maxLength']) {
      expect(`${keyword}: ${String(confirmation?.[keyword])}`)
        .toBe(`${keyword}: ${String(published?.[keyword])}`);
    }
  });
});

describe('the identifiers a request carries', () => {
  it('takes each path parameter from the schema module that owns it', () => {
    // `toBe` again: a hand-written `Type.String()` in the path container would
    // satisfy every shape assertion above and would stop tracking the bound the
    // identifier's own module states.
    const params = (route: AppRoute): Record<string, unknown> => (
      (route.pathParams as { properties: Record<string, unknown> }).properties
    );

    expect(params(contract.getCompanyDashboard)['companyId']).toBe(CompanyId);
    expect(params(contract.listCompanyTransactions)['companyId']).toBe(CompanyId);
    expect(params(contract.activateCard)['companyId']).toBe(CompanyId);
    expect(params(contract.activateCard)['cardId']).toBe(CardId);
  });
});
