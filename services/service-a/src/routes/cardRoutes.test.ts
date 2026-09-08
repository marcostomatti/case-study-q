/**
 * The activation route, against a real Postgres.
 *
 * `routes/router.test.ts` pins what this route does before it reads anything.
 * What is left is the branching, and every branch here is a different answer
 * to what looks like the same request:
 *
 * - **`404` for a card that is not this caller's**, spelled the same way as
 *   for a card that does not exist. Reading the difference is how an
 *   unauthorised caller enumerates identifiers.
 * - **`400` for a last-four that does not match**, naming the field, so the
 *   app can re-prompt the same input — and the card must be left alone.
 * - **`409` for a card that cannot be activated**, both when it was never
 *   activatable and when another request got there first.
 * - **`200` with the card as the contract publishes it**, which is a different
 *   shape from the row that was written.
 *
 * Every write runs against its own planted database rather than the seeded
 * one, so the seeded card stays `issued` for the dashboard suite and no case
 * depends on running after another. The activation instant is fixed by the
 * dependencies' clock, which is why a case can assert it as a literal.
 */
import type { RouteDependencies } from './dependencies';
import type { ServiceDatabase } from '../repositories/database';
import type { SeededPostgres } from '../testing/seededDatabase';
import type { Card as ContractCard, ErrorResponse } from '@marcos-corp/contracts-service-a';
import type { Card as CardRow, NewCard, NewCompany } from '@marcos-corp/db';

import { cards, companies } from '@marcos-corp/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { invokeRoute } from '../testing/routeInvocation';
import {
  SEEDED_DATABASE_TIMEOUT_MS,
  startSeededDatabase,
} from '../testing/seededDatabase';

import { activateCardRoute } from './cardRoutes';

/** Where `server.ts` will say card artwork is served from. */
const ART_BASE_URL = 'https://cdn.example.com/assets';

/** The instant every activation here is stamped with. */
const ACTIVATED_AT = new Date('2026-09-08T12:00:00.000Z');

/** The digits printed on every planted card. */
const LAST_FOUR = '1111';

/**
 * The two companies, as identifiers first.
 *
 * Named separately rather than read back off the rows below: `NewCompany`
 * types every generated column as optional, so an identifier read back off an
 * insert row is `string | undefined`, and every use of it would need a
 * narrowing that says nothing about this route.
 */
const COMPANY_IDS = {
  owner: '0000000a-0000-4000-8000-00000000000a',
  other: '0000000b-0000-4000-8000-00000000000b',
} as const;

const OWNER: NewCompany = {
  id: COMPANY_IDS.owner,
  registeredLegalName: 'Owner Sverige AB',
  displayName: 'Owner AB',
  organisationNumber: '200000-0001',
  defaultCurrencyCode: 'SEK',
};

const OTHER: NewCompany = {
  id: COMPANY_IDS.other,
  registeredLegalName: 'Other Sverige AB',
  displayName: 'Other AB',
  organisationNumber: '200000-0002',
  defaultCurrencyCode: 'SEK',
};

/** One card per branch, so no case has to undo another's write. */
const CARD_IDS = {
  activatable: '000000c1-0000-4000-8000-000000000001',
  twice: '000000c2-0000-4000-8000-000000000002',
  mismatch: '000000c3-0000-4000-8000-000000000003',
  frozen: '000000c4-0000-4000-8000-000000000004',
  shape: '000000c5-0000-4000-8000-000000000005',
  keys: '000000c7-0000-4000-8000-000000000007',
  elsewhere: '000000c6-0000-4000-8000-000000000006',
} as const;

/** A legal identifier of the issued shape that names no row. */
const UNKNOWN_CARD_ID = '88888888-8888-4888-8888-888888888888';

/** A shape this provider has never issued, so no read is worth making. */
const UNISSUABLE_ID = 'not-a-uuid';

function plantedCard(
  id: string,
  lifecycleStatus: CardRow['lifecycleStatus'],
  companyId: string = COMPANY_IDS.owner,
): NewCard {
  return {
    id,
    companyId,
    panLastFour: LAST_FOUR,
    lifecycleStatus,
    artAssetKey: 'card-art/planted',
  };
}

const PLANTED: NewCard[] = [
  plantedCard(CARD_IDS.activatable, 'issued'),
  plantedCard(CARD_IDS.twice, 'issued'),
  plantedCard(CARD_IDS.mismatch, 'issued'),
  plantedCard(CARD_IDS.frozen, 'frozen'),
  plantedCard(CARD_IDS.shape, 'issued'),
  plantedCard(CARD_IDS.keys, 'issued'),
  plantedCard(CARD_IDS.elsewhere, 'issued', COMPANY_IDS.other),
];

let postgres: SeededPostgres;
let planted: ServiceDatabase;
let deps: RouteDependencies;

/**
 * Dependencies whose database throws on contact, for the cases that assert a
 * route answered *before* reading rather than merely instead of reading.
 */
const UNREACHABLE: RouteDependencies = {
  db: new Proxy({}, {
    get(_target, property) {
      throw new Error(`this case may not reach the database, and it read '${String(property)}'`);
    },
  }) as ServiceDatabase,
  cardMapping: { artBaseUrl: ART_BASE_URL },
  now: () => ACTIVATED_AT,
};

/** Activates one card as the owner, with the planted database behind it. */
async function activate(
  cardId: string,
  confirmedLastFour: string = LAST_FOUR,
  companyId: string = COMPANY_IDS.owner,
): Promise<{ status: number; body: ContractCard & ErrorResponse }> {
  return invokeRoute(activateCardRoute(deps), {
    params: { companyId, cardId },
    body: { confirmedLastFour },
  });
}

async function readCard(id: string): Promise<CardRow | null> {
  const rows = await planted.select()
    .from(cards)
    .where(eq(cards.id, id));
  return rows[0] ?? null;
}

beforeAll(async () => {
  postgres = await startSeededDatabase();
  planted = await postgres.createEmptyDatabase();
  await planted.insert(companies).values([OWNER, OTHER]);
  await planted.insert(cards).values(PLANTED);
  deps = { db: planted, cardMapping: { artBaseUrl: ART_BASE_URL }, now: () => ACTIVATED_AT };
}, SEEDED_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await postgres?.stop();
});

describe('activateCard', () => {
  it('activates an issued card and answers with the updated card', async () => {
    const answer = await activate(CARD_IDS.activatable);

    expect(answer.status).toBe(200);
    expect(answer.body).toStrictEqual({
      id: CARD_IDS.activatable,
      lastFour: LAST_FOUR,
      state: 'active',
      artUrl: `${ART_BASE_URL}/card-art/planted.png`,
      activatedAt: ACTIVATED_AT.toISOString(),
    });
  });

  it('writes the activation, rather than only reporting one', async () => {
    await activate(CARD_IDS.shape);
    const row = await readCard(CARD_IDS.shape);

    expect(row?.lifecycleStatus).toBe('active');
    expect(row?.activatedAt).toStrictEqual(ACTIVATED_AT);
  });

  it('publishes the contract\'s card, not the row that was written', async () => {
    // A mapper written as a spread of the row would compile and publish
    // `companyId`, `lifecycleStatus`, `panLastFour` and `artAssetKey`. The
    // whole-payload assertion above states it; these name the columns.
    const answer = await activate(CARD_IDS.keys);

    expect(Object.keys(answer.body).sort())
      .toStrictEqual(['activatedAt', 'artUrl', 'id', 'lastFour', 'state']);
  });

  it('answers 409 to a second activation of the same card', async () => {
    const first = await activate(CARD_IDS.twice);
    const second = await activate(CARD_IDS.twice);

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('conflict');
  });

  it('leaves the first activation\'s instant untouched', async () => {
    // Asserting only the `409` passes against an implementation that updated
    // the row and reported a conflict anyway.
    await activate(CARD_IDS.twice);
    const row = await readCard(CARD_IDS.twice);

    expect(row?.activatedAt).toStrictEqual(ACTIVATED_AT);
    expect(row?.lifecycleStatus).toBe('active');
  });

  it('answers 409 for a card that was never activatable', async () => {
    const answer = await activate(CARD_IDS.frozen);

    expect(answer.status).toBe(409);
    expect(answer.body.code).toBe('conflict');
  });

  it('leaves a card it refused to activate alone', async () => {
    await activate(CARD_IDS.frozen);
    const row = await readCard(CARD_IDS.frozen);

    expect(row?.lifecycleStatus).toBe('frozen');
    expect(row?.activatedAt).toBeNull();
  });

  it('answers 400 naming the field when the last four do not match', async () => {
    const answer = await activate(CARD_IDS.mismatch, '9999');

    expect(answer.status).toBe(400);
    expect(answer.body.code).toBe('validation_failed');
    expect(answer.body.fields).toStrictEqual(['confirmedLastFour']);
  });

  it('does not activate a card whose last four did not match', async () => {
    // The control the case above needs: a route that answered `400` after
    // writing would pass it.
    await activate(CARD_IDS.mismatch, '9999');
    const row = await readCard(CARD_IDS.mismatch);

    expect(row?.lifecycleStatus).toBe('issued');
    expect(row?.activatedAt).toBeNull();
  });

  it('activates that same card once the last four match', async () => {
    // The positive control: without it, a route that refused every activation
    // would satisfy both cases above.
    const answer = await activate(CARD_IDS.mismatch);

    expect(answer.status).toBe(200);
  });

  it('answers 404 for a real card asked for under the wrong company', async () => {
    // Both identifiers name existing rows; only the pairing is wrong. A route
    // that dropped the company would activate somebody else's card.
    const answer = await activate(CARD_IDS.elsewhere, LAST_FOUR, COMPANY_IDS.owner);

    expect(answer.status).toBe(404);
    expect(answer.body.code).toBe('not_found');
  });

  it('leaves that card unactivated', async () => {
    await activate(CARD_IDS.elsewhere, LAST_FOUR, COMPANY_IDS.owner);
    const row = await readCard(CARD_IDS.elsewhere);

    expect(row?.lifecycleStatus).toBe('issued');
  });

  it('answers 404 for a legal identifier that names no card', async () => {
    const answer = await activate(UNKNOWN_CARD_ID);

    expect(answer.status).toBe(404);
    expect(answer.body.code).toBe('not_found');
  });

  it('answers 404 for an unissuable card id without reading anything', async () => {
    const answer = await invokeRoute<ErrorResponse>(activateCardRoute(UNREACHABLE), {
      params: { companyId: COMPANY_IDS.owner, cardId: UNISSUABLE_ID },
      body: { confirmedLastFour: LAST_FOUR },
    });

    expect(answer.status).toBe(404);
  });

  it('answers 404 for an unissuable company id without reading anything', async () => {
    const answer = await invokeRoute<ErrorResponse>(activateCardRoute(UNREACHABLE), {
      params: { companyId: UNISSUABLE_ID, cardId: CARD_IDS.activatable },
      body: { confirmedLastFour: LAST_FOUR },
    });

    expect(answer.status).toBe(404);
  });

  it('answers 400 for an unknown body field, naming it', async () => {
    const answer = await invokeRoute<ErrorResponse>(activateCardRoute(UNREACHABLE), {
      params: { companyId: COMPANY_IDS.owner, cardId: CARD_IDS.activatable },
      body: { confirmedLastFour: LAST_FOUR, force: true },
    });

    expect(answer.status).toBe(400);
    expect(answer.body.fields).toStrictEqual(['force']);
  });

  it('answers 400 for a missing body field, naming it', async () => {
    const answer = await invokeRoute<ErrorResponse>(activateCardRoute(UNREACHABLE), {
      params: { companyId: COMPANY_IDS.owner, cardId: CARD_IDS.activatable },
      body: {},
    });

    expect(answer.status).toBe(400);
    expect(answer.body.fields).toStrictEqual(['confirmedLastFour']);
  });

  it('answers 400 for a last four the contract\'s pattern refuses', async () => {
    const answer = await invokeRoute<ErrorResponse>(activateCardRoute(UNREACHABLE), {
      params: { companyId: COMPANY_IDS.owner, cardId: CARD_IDS.activatable },
      body: { confirmedLastFour: 'abcd' },
    });

    expect(answer.status).toBe(400);
    expect(answer.body.fields).toStrictEqual(['confirmedLastFour']);
  });

  it('checks the body before it reads the card', async () => {
    // Every 400 case above runs against the unreachable database, so all of
    // them state ordering as well as outcome. This names the claim.
    await expect(invokeRoute<ErrorResponse>(activateCardRoute(UNREACHABLE), {
      params: { companyId: COMPANY_IDS.owner, cardId: CARD_IDS.activatable },
      body: { confirmedLastFour: 'abcd' },
    })).resolves.toMatchObject({ status: 400 });
  });
});
