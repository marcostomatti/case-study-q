/**
 * The card reads and the activation write, against a real Postgres.
 *
 * Three claims here cannot be made without one, and each is a wrong answer
 * that looks right:
 *
 * - **Scoping.** `findCardById` and `activateCard` both take a company, and
 *   the company has to reach the `WHERE` clause. A card identifier belonging
 *   to somebody else must answer as if it did not exist.
 * - **The activation guard is in SQL.** Two activations of one card must
 *   produce one row change, not two — and the second must not overwrite the
 *   first `activated_at`. A guard written in JavaScript between a read and a
 *   write passes every single-threaded test and loses that race.
 * - **The returned row is the Drizzle row**, `activated_at` included, so a
 *   route can hand it straight to `mapping/cardMapper.ts` without a second
 *   read.
 *
 * The write cases run against their own database with their own planted rows,
 * so the seeded one stays readable and no case depends on running after
 * another.
 */
import type { ServiceDatabase } from './database';
import type { SeededPostgres } from '../testing/seededDatabase';
import type { Card, NewCard, NewCompany } from '@marcos-corp/db';

import { cards, companies } from '@marcos-corp/db';
import { SEED_CARD_ID, SEED_COMPANY_ID } from '@marcos-corp/db/seed';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SEED_NOW,
  SEEDED_DATABASE_TIMEOUT_MS,
  startSeededDatabase,
} from '../testing/seededDatabase';

import {
  ACTIVATABLE_LIFECYCLE_STATUSES,
  ACTIVATED_LIFECYCLE_STATUS,
  activateCard,
  findCardById,
  findCompanyCard,
} from './cardRepository';

/** Legal uuids that no row carries, so the lookup reaches SQL and finds nothing. */
const UNKNOWN_COMPANY_ID = '99999999-9999-4999-8999-999999999999';
const UNKNOWN_CARD_ID = '88888888-8888-4888-8888-888888888888';

/** The whole seeded card. `activatedAt` is null: the seed leaves it `issued`. */
const SEEDED_CARD: Card = {
  id: SEED_CARD_ID,
  companyId: SEED_COMPANY_ID,
  panLastFour: '4321',
  lifecycleStatus: 'issued',
  activatedAt: null,
  artAssetKey: 'card-art/business-black-v2',
};

/** The two companies the write cases use: one that owns cards, one that does not. */
const OWNER: NewCompany = {
  id: '0000000a-0000-4000-8000-00000000000a',
  registeredLegalName: 'Owner Sverige AB',
  displayName: 'Owner AB',
  organisationNumber: '200000-0001',
  defaultCurrencyCode: 'SEK',
};
const CARDLESS: NewCompany = {
  id: '0000000b-0000-4000-8000-00000000000b',
  registeredLegalName: 'Cardless Sverige AB',
  displayName: 'Cardless AB',
  organisationNumber: '200000-0002',
  defaultCurrencyCode: 'SEK',
};

/** One card per lifecycle state that matters, plus a second `issued` one. */
const CARD_IDS = {
  issued: '000000c1-0000-4000-8000-000000000001',
  ordered: '000000c2-0000-4000-8000-000000000002',
  frozen: '000000c3-0000-4000-8000-000000000003',
  terminated: '000000c4-0000-4000-8000-000000000004',
  // Sorts after every id above, so `findCompanyCard` returning the lowest is a
  // reading rather than a coincidence of insertion order.
  second: '000000d9-0000-4000-8000-000000000009',
} as const;

function plantedCard(id: string, lifecycleStatus: Card['lifecycleStatus']): NewCard {
  return {
    id,
    companyId: OWNER.id,
    panLastFour: '1111',
    lifecycleStatus,
    artAssetKey: 'card-art/planted',
  };
}

const PLANTED: NewCard[] = [
  plantedCard(CARD_IDS.second, 'issued'),
  plantedCard(CARD_IDS.issued, 'issued'),
  plantedCard(CARD_IDS.ordered, 'ordered'),
  plantedCard(CARD_IDS.frozen, 'frozen'),
  plantedCard(CARD_IDS.terminated, 'terminated'),
];

let postgres: SeededPostgres;
let seeded: ServiceDatabase;
let planted: ServiceDatabase;

async function readCard(db: ServiceDatabase, id: string): Promise<Card | null> {
  const rows = await db.select()
    .from(cards)
    .where(eq(cards.id, id));
  return rows[0] ?? null;
}

beforeAll(async () => {
  postgres = await startSeededDatabase();
  seeded = postgres.db;

  planted = await postgres.createEmptyDatabase();
  await planted.insert(companies).values([OWNER, CARDLESS]);
  await planted.insert(cards).values(PLANTED);
}, SEEDED_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await postgres?.stop();
});

describe('findCardById', () => {
  it('returns the whole Drizzle row, with activated_at still null', async () => {
    await expect(findCardById(seeded, { companyId: SEED_COMPANY_ID, cardId: SEED_CARD_ID }))
      .resolves.toStrictEqual(SEEDED_CARD);
  });

  it('returns null for a real card asked for under the wrong company', async () => {
    // The scoping claim. Both identifiers below name existing rows; only the
    // pairing is wrong, so a query that dropped the company from its `WHERE`
    // would return the card and this is the only case that says so.
    await expect(findCardById(planted, {
      companyId: CARDLESS.id,
      cardId: CARD_IDS.issued,
    })).resolves.toBeNull();

    await expect(findCardById(planted, {
      companyId: OWNER.id,
      cardId: CARD_IDS.issued,
    })).resolves.not.toBeNull();
  });

  it('returns null for a card identifier no row carries', async () => {
    await expect(findCardById(seeded, {
      companyId: SEED_COMPANY_ID,
      cardId: UNKNOWN_CARD_ID,
    })).resolves.toBeNull();
  });
});

describe('findCompanyCard', () => {
  it('returns the company card the mobile view renders', async () => {
    await expect(findCompanyCard(seeded, SEED_COMPANY_ID)).resolves.toStrictEqual(SEEDED_CARD);
  });

  it('returns null for a company that holds no card', async () => {
    await expect(findCompanyCard(planted, CARDLESS.id)).resolves.toBeNull();
    // The control: the same database answers for a company that does hold one.
    await expect(findCompanyCard(planted, OWNER.id)).resolves.not.toBeNull();
  });

  it('returns the same card every time when a company holds several', async () => {
    // Not a claim that the lowest identifier is the right card — it is a claim
    // that the answer does not flap. Five cards, inserted with the highest
    // identifier first, so insertion order and identifier order disagree.
    const first = await findCompanyCard(planted, OWNER.id);
    const again = await findCompanyCard(planted, OWNER.id);

    expect(first?.id).toBe(CARD_IDS.issued);
    expect(again?.id).toBe(first?.id);
  });

  it('returns null for a company that does not exist', async () => {
    await expect(findCompanyCard(seeded, UNKNOWN_COMPANY_ID)).resolves.toBeNull();
  });
});

describe('ACTIVATABLE_LIFECYCLE_STATUSES', () => {
  it('is the issuing pipeline and nothing else', () => {
    expect([...ACTIVATABLE_LIFECYCLE_STATUSES].sort()).toEqual(['issued', 'ordered']);
  });

  it('excludes every state an activation must refuse', () => {
    // An absence, so it needs the presence assertion above beside it: an empty
    // list would satisfy this case on its own and refuse every activation.
    expect(ACTIVATABLE_LIFECYCLE_STATUSES).not.toContain(ACTIVATED_LIFECYCLE_STATUS);
    expect(ACTIVATABLE_LIFECYCLE_STATUSES).not.toContain('frozen');
    expect(ACTIVATABLE_LIFECYCLE_STATUSES).not.toContain('terminated');
  });
});

describe('activateCard', () => {
  it('activates an issued card and returns the updated row', async () => {
    const updated = await activateCard(planted, {
      companyId: OWNER.id,
      cardId: CARD_IDS.issued,
      activatedAt: SEED_NOW,
    });

    expect(updated?.lifecycleStatus).toBe(ACTIVATED_LIFECYCLE_STATUS);
    expect(updated?.activatedAt).toEqual(SEED_NOW);
    // The row that came back is the row in the table, so a route needs no
    // second read before mapping it.
    await expect(readCard(planted, CARD_IDS.issued)).resolves.toStrictEqual(updated);
  });

  it('activates an ordered card too', async () => {
    const updated = await activateCard(planted, {
      companyId: OWNER.id,
      cardId: CARD_IDS.ordered,
      activatedAt: SEED_NOW,
    });

    expect(updated?.lifecycleStatus).toBe(ACTIVATED_LIFECYCLE_STATUS);
  });

  it('refuses a second activation and leaves the first instant untouched', async () => {
    // Runs after the first case above, against the card it activated. This is
    // the guard's whole point: a blind UPDATE would answer with a row here and
    // move `activated_at` to the later instant, so a double-tap would be
    // indistinguishable from the first tap and the original activation time
    // would be gone.
    const later = new Date(SEED_NOW.getTime() + 60_000);

    await expect(activateCard(planted, {
      companyId: OWNER.id,
      cardId: CARD_IDS.issued,
      activatedAt: later,
    })).resolves.toBeNull();

    await expect(readCard(planted, CARD_IDS.issued))
      .resolves.toMatchObject({ activatedAt: SEED_NOW });
  });

  it('refuses a frozen card, which is unfrozen rather than activated', async () => {
    await expect(activateCard(planted, {
      companyId: OWNER.id,
      cardId: CARD_IDS.frozen,
      activatedAt: SEED_NOW,
    })).resolves.toBeNull();

    await expect(readCard(planted, CARD_IDS.frozen))
      .resolves.toMatchObject({ lifecycleStatus: 'frozen', activatedAt: null });
  });

  it('refuses a terminated card, which never comes back', async () => {
    await expect(activateCard(planted, {
      companyId: OWNER.id,
      cardId: CARD_IDS.terminated,
      activatedAt: SEED_NOW,
    })).resolves.toBeNull();

    await expect(readCard(planted, CARD_IDS.terminated))
      .resolves.toMatchObject({ lifecycleStatus: 'terminated' });
  });

  it('refuses a card asked for under the wrong company, and changes nothing', async () => {
    // The scoping claim again, this time on the write. Without the company in
    // the `WHERE` clause another tenant activates this card and the only trace
    // is a lifecycle state that changed on its own.
    await expect(activateCard(planted, {
      companyId: CARDLESS.id,
      cardId: CARD_IDS.second,
      activatedAt: SEED_NOW,
    })).resolves.toBeNull();

    await expect(readCard(planted, CARD_IDS.second))
      .resolves.toMatchObject({ lifecycleStatus: 'issued', activatedAt: null });

    // The control: the right company activates the same card.
    await expect(activateCard(planted, {
      companyId: OWNER.id,
      cardId: CARD_IDS.second,
      activatedAt: SEED_NOW,
    })).resolves.not.toBeNull();
  });

  it('returns null for a card identifier no row carries', async () => {
    await expect(activateCard(seeded, {
      companyId: SEED_COMPANY_ID,
      cardId: UNKNOWN_CARD_ID,
      activatedAt: SEED_NOW,
    })).resolves.toBeNull();
  });
});
