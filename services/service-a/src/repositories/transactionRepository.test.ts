/**
 * The transaction reads, against a real Postgres.
 *
 * Four claims here, in rising order of how quietly they fail:
 *
 * - **`3 + 54 = 57`.** The figures the mobile view renders come out of these
 *   two functions, and `packages/db`'s seed is built so that they are readable
 *   rather than assumed.
 * - **The tie-break is a total order.** Two rows booked at the same instant is
 *   what an acquirer's batch looks like, and offset paging over a partial
 *   order hands one row to two pages and never hands over another. Every page
 *   still looks correct on its own.
 * - **The de-duplication in `findDashboardTransactions` is load-bearing.** The
 *   window rows and the newest rows overlap, `mapping/dashboardMapper.ts` sums
 *   the array it is given, and a duplicated settled row moves the meter. The
 *   case below reads `5 400` back through the real mapper, which is the only
 *   assertion here that a missing `Map` would fail.
 * - **The ordering reaches the index.** `packages/db` declares
 *   `transactions_company_id_booked_at_idx` ascending specifically so this
 *   read can be an `Index Scan Backward`, and that decision is invisible to
 *   every other gate in the repository. The plan cases below read it out of
 *   Postgres, with the `NULLS LAST` spelling beside them as the control — a
 *   plan test with nothing to contrast against passes on a planner that sorts
 *   everything.
 */
import type { ServiceDatabase } from './database';
import type { SeededPostgres } from '../testing/seededDatabase';
import type { NewCard, NewCompany, NewTransaction } from '@marcos-corp/db';

import { cards, companies, transactions } from '@marcos-corp/db';
import { SEED_CARD_ID, SEED_COMPANY_ID, SEED_FIGURES } from '@marcos-corp/db/seed';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { settledSpendMinorUnits } from '../mapping/dashboardMapper';
import {
  SEED_NOW,
  SEEDED_DATABASE_TIMEOUT_MS,
  startSeededDatabase,
} from '../testing/seededDatabase';

import { PageRequestError } from './pagination';
import {
  countCompanyTransactions,
  findDashboardTransactions,
  listCompanyTransactions,
  NEWEST_FIRST,
} from './transactionRepository';

/** A legal uuid no row carries. */
const UNKNOWN_COMPANY_ID = '99999999-9999-4999-8999-999999999999';

const MILLISECONDS_PER_DAY = 86_400_000;

/** The seed opens the spend window 30 days before `SEED_NOW`. */
const SEEDED_WINDOW_OPENED_AT = new Date(SEED_NOW.getTime() - 30 * MILLISECONDS_PER_DAY);

/** The seed's identifiers run `...0001` (newest) to `...0057` (oldest). */
function seededTransactionId(oneBased: number): string {
  return `55555555-5555-4555-8555-${String(oneBased).padStart(12, '0')}`;
}

/** Rows the seed does not provide: two cards, and a batch booked at one instant. */
const OWNER: NewCompany = {
  id: '0000000a-0000-4000-8000-0000000000b1',
  registeredLegalName: 'Batch Sverige AB',
  displayName: 'Batch AB',
  organisationNumber: '400000-0001',
  defaultCurrencyCode: 'SEK',
};

const BATCH_CARD: NewCard = {
  id: '000000c1-0000-4000-8000-0000000000b1',
  companyId: OWNER.id,
  panLastFour: '4444',
  lifecycleStatus: 'active',
  artAssetKey: 'card-art/planted',
};

/** The other card's single row. Sorts above every batch id inside the tie. */
const OTHER_CARD_TRANSACTION_ID = '000000e1-0000-4000-8000-0000000000e1';

/** A second card in the same company. Its rows must not reach the first's meter. */
const OTHER_CARD: NewCard = {
  id: '000000c2-0000-4000-8000-0000000000b2',
  companyId: OWNER.id,
  panLastFour: '5555',
  lifecycleStatus: 'active',
  artAssetKey: 'card-art/planted',
};

/** One instant, four rows: exactly what an acquirer booking a batch produces. */
const BATCH_BOOKED_AT = new Date(SEED_NOW.getTime() - MILLISECONDS_PER_DAY);
const OLD_BOOKED_AT = new Date(SEED_NOW.getTime() - 400 * MILLISECONDS_PER_DAY);

function plantedTransaction(
  id: string,
  cardId: string,
  bookedAt: Date,
  amountMinorUnits: number,
): NewTransaction {
  return {
    id,
    cardId,
    companyId: OWNER.id,
    bookedAt,
    amountMinorUnits,
    currencyCode: 'SEK',
    merchantName: 'Planted',
    merchantCategoryCode: '5814',
    settlementState: 'settled',
  };
}

const BATCH_IDS = [1, 2, 3, 4].map((n) => `000000b${n}-0000-4000-8000-00000000000${n}`);

const PLANTED_TRANSACTIONS: NewTransaction[] = [
  // All four share one `booked_at`, so only the identifier can order them.
  ...BATCH_IDS.map((id) => plantedTransaction(id, BATCH_CARD.id, BATCH_BOOKED_AT, 1_000)),
  // The other card's row, in the window, settled, and a distinctive amount.
  plantedTransaction(OTHER_CARD_TRANSACTION_ID, OTHER_CARD.id, BATCH_BOOKED_AT, 777_000),
];

/**
 * A second company in the same database, with its own card and its own rows.
 *
 * Without it, every database in this suite holds exactly one company and
 * "counts one company and not the table" is unfalsifiable — measured: dropping
 * the `WHERE` clause from `countCompanyTransactions` reddened one case, and
 * not that one.
 */
const NEIGHBOUR: NewCompany = {
  id: '0000000a-0000-4000-8000-0000000000b9',
  registeredLegalName: 'Neighbour Sverige AB',
  displayName: 'Neighbour AB',
  organisationNumber: '400000-0009',
  defaultCurrencyCode: 'SEK',
};

const NEIGHBOUR_CARD: NewCard = {
  id: '000000c9-0000-4000-8000-0000000000b9',
  companyId: NEIGHBOUR.id,
  panLastFour: '9999',
  lifecycleStatus: 'active',
  artAssetKey: 'card-art/planted',
};

/**
 * Booked at the same instant as the batch and with identifiers that sort
 * **above** every one of them, so a company filter dropped anywhere in this
 * module reorders the tie-break case as well as failing the scoping case
 * below. Measured: with these sorting below the batch instead, dropping
 * `listCompanyTransactions`'s `WHERE` reddened nothing at all.
 */
const NEIGHBOUR_TRANSACTION_IDS = ['fa', 'fb', 'fc'].map(
  (suffix) => `000000${suffix}-0000-4000-8000-0000000000${suffix}`,
);

/** A card whose only rows are far older than any window it could be under. */
const QUIET_CARD: NewCard = {
  id: '000000c3-0000-4000-8000-0000000000b3',
  companyId: OWNER.id,
  panLastFour: '6666',
  lifecycleStatus: 'active',
  artAssetKey: 'card-art/planted',
};

const QUIET_IDS = [1, 2].map((n) => `000000f${n}-0000-4000-8000-00000000000${n}`);

let postgres: SeededPostgres;
let seeded: ServiceDatabase;
let planted: ServiceDatabase;

/**
 * The plan Postgres would use, with the two access paths that hide an ordering
 * switched off.
 *
 * Both `SET LOCAL`s are needed and neither is a cheat. At 57 rows a sequential
 * scan is genuinely cheapest, and a bitmap scan — which the planner reaches for
 * next — loses the index's ordering and always adds a sort, so without them
 * every query below plans identically and the cases say nothing. `LOCAL`, and
 * inside a transaction, because the settings must land on the same pooled
 * connection as the `EXPLAIN` and must not leak to another case.
 */
async function planFor(query: ReturnType<typeof sql>): Promise<string> {
  return seeded.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
    const { rows } = await tx.execute(query);
    return rows.map((row) => String(row['QUERY PLAN'])).join('\n');
  });
}

/** A plain `Sort` node, which `Incremental Sort` deliberately does not match. */
const FULL_SORT_NODE = /->\s+Sort\b/;

beforeAll(async () => {
  postgres = await startSeededDatabase();
  seeded = postgres.db;

  planted = await postgres.createEmptyDatabase();
  await planted.insert(companies).values([OWNER, NEIGHBOUR]);
  await planted.insert(cards).values([BATCH_CARD, OTHER_CARD, QUIET_CARD, NEIGHBOUR_CARD]);
  await planted.insert(transactions).values([
    ...PLANTED_TRANSACTIONS,
    ...QUIET_IDS.map((id) => plantedTransaction(id, QUIET_CARD.id, OLD_BOOKED_AT, 2_000)),
    ...NEIGHBOUR_TRANSACTION_IDS.map((id) => ({
      ...plantedTransaction(id, NEIGHBOUR_CARD.id, BATCH_BOOKED_AT, 3_000),
      companyId: NEIGHBOUR.id,
    })),
  ]);
}, SEEDED_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await postgres?.stop();
});

describe('countCompanyTransactions', () => {
  it('counts the 57 rows behind three shown and 54 more', async () => {
    // Strictly a number: `count(*)` is a `bigint` in Postgres and `pg` renders
    // one as a string, so a total that stopped being mapped would arrive here
    // as '57' and fail rather than being coerced somewhere downstream.
    await expect(countCompanyTransactions(seeded, SEED_COMPANY_ID))
      .resolves.toBe(SEED_FIGURES.transactionCount);
  });

  it('counts zero for a company with no transactions', async () => {
    await expect(countCompanyTransactions(seeded, UNKNOWN_COMPANY_ID)).resolves.toBe(0);
    await expect(countCompanyTransactions(seeded, SEED_COMPANY_ID)).resolves.toBe(57);
  });

  it('counts one company and not the table', async () => {
    // Two companies in one database, so a count that dropped its `WHERE`
    // returns the same figure for both. Comparing two single-company databases
    // instead cannot say this — measured, and it is what this case used to do.
    const owner = await countCompanyTransactions(planted, OWNER.id);
    const neighbour = await countCompanyTransactions(planted, NEIGHBOUR.id);

    expect(owner).toBe(PLANTED_TRANSACTIONS.length + QUIET_IDS.length);
    expect(neighbour).toBe(NEIGHBOUR_TRANSACTION_IDS.length);
    expect(owner).not.toBe(neighbour);
  });
});

describe('listCompanyTransactions', () => {
  it('lists the three the dashboard shows, newest first', async () => {
    const page = await listCompanyTransactions(
      seeded,
      { companyId: SEED_COMPANY_ID },
      { limit: SEED_FIGURES.dashboardTransactionCount, offset: 0 },
    );

    expect(page.items.map((row) => row.id)).toEqual([1, 2, 3].map(seededTransactionId));
    expect(page.items.map((row) => row.merchantName)).toEqual([
      'Scandic Malmo',
      'Circle K Solna',
      'Pressbyran Odenplan',
    ]);
  });

  it('leaves exactly the 54 the screen counts behind those three', async () => {
    const page = await listCompanyTransactions(
      seeded,
      { companyId: SEED_COMPANY_ID },
      { limit: SEED_FIGURES.dashboardTransactionCount, offset: 0 },
    );

    expect(page.total - page.items.length).toBe(SEED_FIGURES.furtherTransactionCount);
    expect(page.total - page.items.length).toBe(54);
  });

  it('pages into the next three without repeating the first three', async () => {
    const second = await listCompanyTransactions(
      seeded,
      { companyId: SEED_COMPANY_ID },
      { limit: 3, offset: 3 },
    );

    expect(second.items.map((row) => row.id)).toEqual([4, 5, 6].map(seededTransactionId));
    expect(second.total).toBe(57);
  });

  it('reaches the oldest row on the last page and reports the same total', async () => {
    const last = await listCompanyTransactions(
      seeded,
      { companyId: SEED_COMPANY_ID },
      { limit: 20, offset: 40 },
    );

    expect(last.items).toHaveLength(17);
    expect(last.items.at(-1)?.id).toBe(seededTransactionId(57));
    expect(last.total).toBe(57);
  });

  it('returns an empty page past the end, and still the true total', async () => {
    const page = await listCompanyTransactions(
      seeded,
      { companyId: SEED_COMPANY_ID },
      { limit: 20, offset: 100 },
    );

    expect(page.items).toEqual([]);
    expect(page.total).toBe(57);
  });

  it('returns whole Drizzle rows, money as two flat columns', async () => {
    // The contract publishes one `MonetaryAmount` object; the row carries an
    // integer and a code, and translating them is `mapping/`'s job. A
    // repository that assembled the object here would be making the decision
    // twice, in the layer that must not make it.
    const page = await listCompanyTransactions(
      seeded,
      { companyId: SEED_COMPANY_ID },
      { limit: 1, offset: 0 },
    );

    expect(page.items[0]).toStrictEqual({
      id: seededTransactionId(1),
      cardId: SEED_CARD_ID,
      companyId: SEED_COMPANY_ID,
      bookedAt: new Date(SEED_NOW.getTime() - 45 * 60_000),
      amountMinorUnits: 22_000,
      currencyCode: 'SEK',
      merchantName: 'Scandic Malmo',
      merchantCategoryCode: '7011',
      settlementState: 'authorised',
    });
  });

  it('pages a batch booked at one instant without repeating or losing a row', async () => {
    // The tie-break claim. Five of this company's rows share a `booked_at`, so
    // ordering on that column alone leaves the planner free to hand one row to
    // two pages and never hand over another — and each page would still look
    // entirely correct on its own.
    const page = async (offset: number): Promise<string[]> => {
      const read = await listCompanyTransactions(
        planted,
        { companyId: OWNER.id },
        { limit: 2, offset },
      );
      return read.items.map((row) => row.id);
    };
    const seen = [...await page(0), ...await page(2), ...await page(4)];

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    // Newest first, and inside the tie the identifier descending.
    expect(seen.slice(0, 5)).toEqual([
      OTHER_CARD_TRANSACTION_ID,
      ...[...BATCH_IDS].reverse(),
    ]);
  });

  it('lists one company and not its neighbour in the same database', async () => {
    // Both companies have rows booked at the same instant, so an unscoped read
    // interleaves them and every page still looks like a page of transactions.
    const wholeTable = { limit: 100, offset: 0 };
    const owner = await listCompanyTransactions(planted, { companyId: OWNER.id }, wholeTable);
    const neighbour = await listCompanyTransactions(
      planted,
      { companyId: NEIGHBOUR.id },
      wholeTable,
    );

    expect(owner.items.every((row) => row.companyId === OWNER.id)).toBe(true);
    expect(owner.items.map((row) => row.id)).not.toContain(NEIGHBOUR_TRANSACTION_IDS[0]);
    // The control: the neighbour's rows are in this database and reachable.
    expect(neighbour.items.map((row) => row.id).sort())
      .toEqual([...NEIGHBOUR_TRANSACTION_IDS].sort());
  });

  it('refuses a page the contract does not publish, before it reaches SQL', async () => {
    await expect(listCompanyTransactions(
      seeded,
      { companyId: SEED_COMPANY_ID },
      { limit: 500, offset: 0 },
    )).rejects.toBeInstanceOf(PageRequestError);
  });
});

describe('findDashboardTransactions', () => {
  it('returns each row once, though the window and the newest three overlap', async () => {
    // 51 rows are inside the seeded window and the newest three are among
    // them, so a concatenation without the `Map` returns 54 with three
    // duplicates — and every row in it is a real row.
    const rows = await findDashboardTransactions(seeded, {
      companyId: SEED_COMPANY_ID,
      cardId: SEED_CARD_ID,
      bookedSince: SEEDED_WINDOW_OPENED_AT,
      listCount: SEED_FIGURES.dashboardTransactionCount,
    });

    expect(rows).toHaveLength(51);
    expect(new Set(rows.map((row) => row.id)).size).toBe(51);
  });

  it('feeds the mapper enough to read 5 400 of 10 000 kr, and not a row more', async () => {
    // The claim the de-duplication exists for, made through the real mapper
    // rather than restated here. The third-newest seeded row is `settled` for
    // 4 500, so a duplicate would put the meter at 535500 — a figure nothing
    // else in this suite would notice.
    const rows = await findDashboardTransactions(seeded, {
      companyId: SEED_COMPANY_ID,
      cardId: SEED_CARD_ID,
      bookedSince: SEEDED_WINDOW_OPENED_AT,
      listCount: SEED_FIGURES.dashboardTransactionCount,
    });
    const spent = settledSpendMinorUnits(rows, SEEDED_WINDOW_OPENED_AT);

    expect(spent).toBe(SEED_FIGURES.settledInPeriodMinorUnits);
    expect(SEED_FIGURES.spendCapMinorUnits - spent).toBe(540_000);
  });

  it('leaves out the rows booked before the window opened', async () => {
    const rows = await findDashboardTransactions(seeded, {
      companyId: SEED_COMPANY_ID,
      cardId: SEED_CARD_ID,
      bookedSince: SEEDED_WINDOW_OPENED_AT,
      listCount: SEED_FIGURES.dashboardTransactionCount,
    });

    // Six settled rows sit before the window and sum to 240000. Returning them
    // would put the meter at 300000 — the wrong answer `packages/db`'s seed is
    // arranged to make distinguishable.
    expect(rows.every((row) => row.bookedAt >= SEEDED_WINDOW_OPENED_AT)).toBe(true);
    expect(rows.map((row) => row.id)).not.toContain(seededTransactionId(57));
  });

  it('still lists a quiet card, whose newest rows are all outside the window', async () => {
    // The inverting leg for the case above: fetching only the window would
    // render an empty transaction list beside a full meter.
    const rows = await findDashboardTransactions(planted, {
      companyId: OWNER.id,
      cardId: QUIET_CARD.id,
      bookedSince: BATCH_BOOKED_AT,
      listCount: 3,
    });

    expect(rows.map((row) => row.id).sort()).toEqual([...QUIET_IDS].sort());
    expect(rows.every((row) => row.bookedAt < BATCH_BOOKED_AT)).toBe(true);
  });

  it('takes only the card asked for, not every card in the company', async () => {
    // A spend limit belongs to a card, so the meter must be measured against
    // that card's rows. The other card's row is settled, in the window and
    // worth 777000 — enough to overrun the cap, which would render as a
    // negative remaining figure with no hint where it came from.
    const rows = await findDashboardTransactions(planted, {
      companyId: OWNER.id,
      cardId: BATCH_CARD.id,
      bookedSince: new Date(BATCH_BOOKED_AT.getTime() - MILLISECONDS_PER_DAY),
      listCount: 3,
    });

    expect(rows.map((row) => row.id).sort()).toEqual([...BATCH_IDS].sort());
    expect(rows.every((row) => row.cardId === BATCH_CARD.id)).toBe(true);
  });

  it('returns nothing when the company scope matches nothing', async () => {
    // The card exists and has 57 rows; only the company is wrong. A read that
    // scoped on the card alone would return all of them.
    const rows = await findDashboardTransactions(seeded, {
      companyId: UNKNOWN_COMPANY_ID,
      cardId: SEED_CARD_ID,
      bookedSince: SEEDED_WINDOW_OPENED_AT,
      listCount: 3,
    });

    expect(rows).toEqual([]);
  });
});

describe('the ordering this repository writes', () => {
  it('renders as a bare descending sort, with no nulls qualifier', async () => {
    // Read off the module's own exported clause rather than restated, so the
    // plan cases below are explaining what the list functions actually issue.
    const rendered = seeded
      .select()
      .from(transactions)
      .orderBy(...NEWEST_FIRST)
      .toSQL().sql;

    expect(rendered)
      .toContain('order by "transactions"."booked_at" desc, "transactions"."id" desc');
    expect(rendered.toLowerCase()).not.toContain('nulls');
  });

  it('is served by reading the ascending index backwards, with no full sort', async () => {
    const plan = await planFor(sql`
      EXPLAIN SELECT * FROM transactions WHERE company_id = ${SEED_COMPANY_ID}
      ORDER BY booked_at DESC, id DESC LIMIT 3`);

    expect(plan).toContain('Index Scan Backward using transactions_company_id_booked_at_idx');
    // An `Incremental Sort` over the presorted `booked_at` is what breaks the
    // ties; a full `Sort` node would mean the index bought nothing.
    expect(plan).not.toMatch(FULL_SORT_NODE);
  });

  it('costs the index the moment a nulls qualifier is added — the control', async () => {
    // The mistake `packages/db` declares the index ascending to avoid, and the
    // reason the case above is a reading rather than a coincidence: on the same
    // table, the same predicate and the same limit, this spelling plans a full
    // sort. Without it, a planner that sorted everything would satisfy the
    // assertion above just as well.
    const plan = await planFor(sql`
      EXPLAIN SELECT * FROM transactions WHERE company_id = ${SEED_COMPANY_ID}
      ORDER BY booked_at DESC NULLS LAST LIMIT 3`);

    expect(plan).toMatch(FULL_SORT_NODE);
    expect(plan).not.toContain('Index Scan Backward');
  });
});
