/**
 * The spend-limit read, against a real Postgres.
 *
 * The lookup looks trivial and hides three decisions the table forces on it —
 * which reset period, which window, and what "current" means at the edge —
 * and each one has a wrong answer that renders as a plausible number on the
 * screen rather than as a failure:
 *
 * - A limit configured for **next** month replacing this month's the moment it
 *   is written, so the meter reads against a cap nobody is under yet.
 * - The **annual** limit answering where the monthly one was meant to, so the
 *   meter reads `5 400/120 000`.
 * - The window boundary excluding the instant it opens, so a card whose limit
 *   was just rolled over reports no limit at all.
 *
 * The rows for those cases are planted rather than seeded: `packages/db`'s seed
 * gives the card exactly one limit, which is what the demo needs and is
 * precisely the shape in which all three mistakes pass.
 */
import type { ServiceDatabase } from './database';
import type { SeededPostgres } from '../testing/seededDatabase';
import type { NewCard, NewCompany, NewSpendLimit } from '@marcos-corp/db';

import { cards, companies, spendLimits } from '@marcos-corp/db';
import { SEED_CARD_ID, SEED_FIGURES } from '@marcos-corp/db/seed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SEED_NOW,
  SEEDED_DATABASE_TIMEOUT_MS,
  startSeededDatabase,
} from '../testing/seededDatabase';

import { DASHBOARD_RESET_PERIOD, findCurrentSpendLimit } from './spendLimitRepository';

/** A legal uuid no card carries. */
const UNKNOWN_CARD_ID = '88888888-8888-4888-8888-888888888888';

const MILLISECONDS_PER_DAY = 86_400_000;

/** The seed opens the window 30 days before `SEED_NOW`. */
const SEEDED_WINDOW_OPENED_AT = new Date(SEED_NOW.getTime() - 30 * MILLISECONDS_PER_DAY);

const OWNER: NewCompany = {
  id: '0000000a-0000-4000-8000-0000000000a1',
  registeredLegalName: 'Limit Sverige AB',
  displayName: 'Limit AB',
  organisationNumber: '300000-0001',
  defaultCurrencyCode: 'SEK',
};

const PLANTED_CARD: NewCard = {
  id: '000000c1-0000-4000-8000-0000000000c1',
  companyId: OWNER.id,
  panLastFour: '2222',
  lifecycleStatus: 'active',
  artAssetKey: 'card-art/planted',
};

/** A card with no limit at all, so "no row" is a state this database can be in. */
const LIMITLESS_CARD: NewCard = {
  id: '000000c2-0000-4000-8000-0000000000c2',
  companyId: OWNER.id,
  panLastFour: '3333',
  lifecycleStatus: 'active',
  artAssetKey: 'card-art/planted',
};

const LAST_MONTH = new Date(SEED_NOW.getTime() - 40 * MILLISECONDS_PER_DAY);
const THIS_MONTH = new Date(SEED_NOW.getTime() - 5 * MILLISECONDS_PER_DAY);
const NEXT_MONTH = new Date(SEED_NOW.getTime() + 25 * MILLISECONDS_PER_DAY);

/**
 * Four rows on one card: two monthly windows already open, one that opens
 * later, and an annual limit whose cap is unmistakable if it is ever returned
 * where the monthly one belongs.
 */
function plantedLimit(
  capMinorUnits: number,
  resetPeriod: NewSpendLimit['resetPeriod'],
  periodStartedAt: Date,
): NewSpendLimit {
  return { cardId: PLANTED_CARD.id, capMinorUnits, resetPeriod, periodStartedAt };
}

const PLANTED_LIMITS: NewSpendLimit[] = [
  plantedLimit(100_000, 'monthly', LAST_MONTH),
  plantedLimit(200_000, 'monthly', THIS_MONTH),
  plantedLimit(300_000, 'monthly', NEXT_MONTH),
  plantedLimit(12_000_000, 'annual', LAST_MONTH),
];

let postgres: SeededPostgres;
let seeded: ServiceDatabase;
let planted: ServiceDatabase;

beforeAll(async () => {
  postgres = await startSeededDatabase();
  seeded = postgres.db;

  planted = await postgres.createEmptyDatabase();
  await planted.insert(companies).values(OWNER);
  await planted.insert(cards).values([PLANTED_CARD, LIMITLESS_CARD]);
  await planted.insert(spendLimits).values(PLANTED_LIMITS);
}, SEEDED_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await postgres?.stop();
});

describe('DASHBOARD_RESET_PERIOD', () => {
  it('is the monthly window the mobile view reads', () => {
    expect(DASHBOARD_RESET_PERIOD).toBe('monthly');
  });
});

describe('findCurrentSpendLimit', () => {
  it('returns the seeded cap as an integer minor-unit number', async () => {
    const limit = await findCurrentSpendLimit(seeded, {
      cardId: SEED_CARD_ID,
      resetPeriod: DASHBOARD_RESET_PERIOD,
      asOf: SEED_NOW,
    });

    // The whole Drizzle row, and `capMinorUnits` strictly a number: a money
    // column widened to `bigint` or `numeric` comes back from `pg` as a string
    // and `toStrictEqual` is what reports it.
    expect(limit).toStrictEqual({
      cardId: SEED_CARD_ID,
      capMinorUnits: SEED_FIGURES.spendCapMinorUnits,
      resetPeriod: 'monthly',
      periodStartedAt: SEEDED_WINDOW_OPENED_AT,
    });
  });

  it('returns the most recently opened window, not the oldest', async () => {
    const limit = await findCurrentSpendLimit(planted, {
      cardId: PLANTED_CARD.id,
      resetPeriod: 'monthly',
      asOf: SEED_NOW,
    });

    expect(limit?.capMinorUnits).toBe(200_000);
  });

  it('ignores a window that has not opened yet', async () => {
    // The inverting leg for the ordering case above. `NEXT_MONTH` sorts newest
    // of the three, so a lookup that takes the latest row without checking
    // `period_started_at <= asOf` returns a cap of 300000 — a figure nobody is
    // under yet, on a screen that gives no hint the window is wrong.
    const limit = await findCurrentSpendLimit(planted, {
      cardId: PLANTED_CARD.id,
      resetPeriod: 'monthly',
      asOf: SEED_NOW,
    });

    expect(limit?.capMinorUnits).not.toBe(300_000);
    expect(limit?.periodStartedAt).toEqual(THIS_MONTH);
  });

  it('returns the future window once it has opened', async () => {
    // The control for the case above: the row is reachable, it was simply not
    // in force yet. Without this, a lookup that never returned that row at all
    // would pass just as happily.
    const limit = await findCurrentSpendLimit(planted, {
      cardId: PLANTED_CARD.id,
      resetPeriod: 'monthly',
      asOf: new Date(NEXT_MONTH.getTime() + MILLISECONDS_PER_DAY),
    });

    expect(limit?.capMinorUnits).toBe(300_000);
  });

  it('counts a window from the instant it opens', async () => {
    // Inclusive, matching `dashboardMapper`'s `booked_at >= period_started_at`.
    // Both sides are read on every dashboard request and an exclusive boundary
    // here would report no limit for a card whose window just rolled over.
    const atTheEdge = await findCurrentSpendLimit(planted, {
      cardId: PLANTED_CARD.id,
      resetPeriod: 'monthly',
      asOf: THIS_MONTH,
    });
    const oneMillisecondBefore = await findCurrentSpendLimit(planted, {
      cardId: PLANTED_CARD.id,
      resetPeriod: 'monthly',
      asOf: new Date(THIS_MONTH.getTime() - 1),
    });

    expect(atTheEdge?.periodStartedAt).toEqual(THIS_MONTH);
    expect(oneMillisecondBefore?.periodStartedAt).toEqual(LAST_MONTH);
  });

  it('answers for the reset period it was asked for, not whichever is newest', async () => {
    const annual = await findCurrentSpendLimit(planted, {
      cardId: PLANTED_CARD.id,
      resetPeriod: 'annual',
      asOf: SEED_NOW,
    });

    expect(annual?.capMinorUnits).toBe(12_000_000);
    expect(annual?.resetPeriod).toBe('annual');
  });

  it('returns null for a reset period this card has no limit under', async () => {
    await expect(findCurrentSpendLimit(planted, {
      cardId: PLANTED_CARD.id,
      resetPeriod: 'quarterly',
      asOf: SEED_NOW,
    })).resolves.toBeNull();

    // The control: the same card, the same instant, a period it does have.
    await expect(findCurrentSpendLimit(planted, {
      cardId: PLANTED_CARD.id,
      resetPeriod: 'monthly',
      asOf: SEED_NOW,
    })).resolves.not.toBeNull();
  });

  it('returns null for a card that has no limit configured at all', async () => {
    await expect(findCurrentSpendLimit(planted, {
      cardId: LIMITLESS_CARD.id,
      resetPeriod: DASHBOARD_RESET_PERIOD,
      asOf: SEED_NOW,
    })).resolves.toBeNull();
  });

  it('returns null for a card identifier no row carries', async () => {
    await expect(findCurrentSpendLimit(seeded, {
      cardId: UNKNOWN_CARD_ID,
      resetPeriod: DASHBOARD_RESET_PERIOD,
      asOf: SEED_NOW,
    })).resolves.toBeNull();
  });
});
