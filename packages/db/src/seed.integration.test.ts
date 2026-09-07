/**
 * The database-backed half of the seed's claim: migrate a throwaway Postgres,
 * run the seed into it, and read the mobile view's own figures back out with
 * SQL.
 *
 * `seed.test.ts` proves `buildSeedRows` *builds* `5 400/10 000 kr` and a list
 * of 57 transactions. It cannot prove any of it survived a `CREATE TABLE`, an
 * `INSERT` and a `SELECT`, and that is the whole of what this file adds. The
 * seeded numbers are load-bearing for the demo — `assets/mobile-view.png` is
 * the artefact a reviewer compares the running stack against — so a later
 * schema change that quietly breaks them should fail here rather than on
 * screen.
 *
 * ## Three rules this file follows, each closing a way it could go vacuous
 *
 *   - **Every figure is read out of Postgres, never off the row builder.**
 *     `buildSeedRows` agrees with itself whatever reached the database. The
 *     queries below are written against the SQL column names directly, not
 *     through the Drizzle table objects the seed inserted with, so a column
 *     renamed in a schema module without a matching migration fails here.
 *   - **Every figure is asserted against the screenshot, not only against
 *     `SEED_FIGURES`.** Comparing what came out of the database to the
 *     constants the seed was built from would pass just as well after somebody
 *     edited both. `MOBILE_VIEW` below is read off the image and is the
 *     independent half; `SEED_FIGURES` is then pinned to it, so the exported
 *     constants other packages consume cannot drift away from the screen
 *     either.
 *   - **The wrong queries are run too.** Asserting only that remaining spend
 *     is `540000` passes against a seed where every transaction is settled and
 *     inside the window — and such a seed would let a `dashboardMapper` that
 *     drops either filter score full marks. The two cases naming `447700` and
 *     `300000` are what stop the seeded rows from going quietly uniform *in
 *     the database*, which is a different claim from `seed.test.ts` making it
 *     about the built rows.
 *
 * ## What it needs, and what happens without it
 *
 * A real server, via `TEST_DATABASE_URL` or a private cluster this suite
 * stands up itself — see `src/testing/throwawayDatabase.ts`. Neither
 * available is one pointed error from `beforeAll` and skipped cases, never a
 * green run: the same argument `@marcos-corp/contract-tooling` makes for
 * shelling out to the real `vacuum` rather than stubbing it.
 */
import type { ThrowawayDatabase, ThrowawayPostgres } from './testing/throwawayDatabase';

import { sql, type SQL } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedDatabase, SEED_COMPANY_ID, SEED_FIGURES } from './seed';
import {
  MIGRATIONS_DIR,
  startThrowawayPostgres,
  THROWAWAY_POSTGRES_TIMEOUT_MS,
} from './testing/throwawayDatabase';

/**
 * Read off `assets/mobile-view.png`, in the units the schema stores.
 *
 * The screen never states a total transaction count: it renders three rows
 * and `54 more items in transaction view`, so 57 is derived here the way a
 * reader derives it, rather than copied from the seed.
 */
const MOBILE_VIEW = {
  /** `5 400/10 000 kr` — the figure the meter leads with. */
  remainingSpendMinorUnits: 540_000,
  /** `5 400/10 000 kr` — "based on your set limit". */
  spendCapMinorUnits: 1_000_000,
  /** `kr`. */
  currencyCode: 'SEK',
  /** Three `Transaction data` rows under "Latest transactions". */
  shownTransactionCount: 3,
  /** `54 more items in transaction view`. */
  furtherTransactionCount: 54,
} as const;

const MOBILE_VIEW_TRANSACTION_COUNT
  = MOBILE_VIEW.shownTransactionCount + MOBILE_VIEW.furtherTransactionCount;

/**
 * The answers a dashboard mapper reaches with one of the two filters missing.
 * Distinct from each other and from the correct figure, which is what lets a
 * test tell them apart. Derived in `seed.ts`; asserted here against SQL.
 */
const WRONG_REMAINING_SPEND = {
  /** Every in-window transaction counted, settled or not. */
  withoutSettlementFilter: 447_700,
  /** Every settled transaction counted, however old. */
  withoutWindowFilter: 300_000,
} as const;

/** The tables the migration must create for the seed to have anywhere to go. */
const MIGRATED_TABLES = [
  'api_usage',
  'cards',
  'companies',
  'invoices',
  'spend_limits',
  'transactions',
];

/** Fixed, so every instant the seed derives is the same on every run. */
const NOW = new Date('2026-09-08T12:00:00.000Z');

let postgres: ThrowawayPostgres;
let database: ThrowawayDatabase;
let tablesBeforeMigrating: string[] = [];

beforeAll(async () => {
  postgres = await startThrowawayPostgres();
  database = await postgres.createDatabase();

  // Read before migrating, so "the migration created these tables" is a claim
  // this file can make. Against an already-populated database the figures
  // below would pass without the migration or the seed having done anything.
  tablesBeforeMigrating = await readPublicTables();

  await migrate(database.db, { migrationsFolder: MIGRATIONS_DIR });
  await seedDatabase(database.db, { now: NOW });
}, THROWAWAY_POSTGRES_TIMEOUT_MS);

afterAll(async () => {
  await postgres?.stop();
});

async function readPublicTables(): Promise<string[]> {
  const { rows } = await database.db.execute(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  return rows.map((row) => String(row.table_name));
}

/**
 * One `SELECT ... AS value` row.
 *
 * Nothing is coerced on the way out. Postgres renders an `integer` column as a
 * JavaScript number and a `bigint` — which is what an uncast `SUM()` returns —
 * as a *string*, so a strict comparison against a numeric literal is itself
 * the check that the money columns are still integers.
 */
async function readValue(query: SQL): Promise<unknown> {
  const { rows } = await database.db.execute(query);
  const row = rows[0];
  if (!row) {
    throw new Error('expected exactly one row, got none');
  }
  return row.value;
}

/**
 * Remaining spend, as `service-a`'s dashboard mapper will compute it: the cap
 * minus the transactions the filter keeps. The filter is a parameter so the
 * same query produces the wrong answers below with one half of it dropped.
 */
function remainingSpend(transactionFilter: SQL): SQL {
  return sql`
    SELECT (sl.cap_minor_units - COALESCE(SUM(tx.amount_minor_units), 0))::int AS value
    FROM spend_limits AS sl
    JOIN cards AS c ON c.id = sl.card_id
    LEFT JOIN transactions AS tx
      ON tx.card_id = sl.card_id
     AND ${transactionFilter}
    WHERE c.company_id = ${SEED_COMPANY_ID}
    GROUP BY sl.cap_minor_units
  `;
}

const SETTLED = sql`tx.settlement_state = 'settled'`;
const IN_WINDOW = sql`tx.booked_at >= sl.period_started_at`;

const transactionCount = (): SQL => sql`
  SELECT count(*)::int AS value
  FROM transactions
  WHERE company_id = ${SEED_COMPANY_ID}
`;

describe('the migrations', () => {
  it('start from an empty database, so no figure below is pre-existing', () => {
    expect(tablesBeforeMigrating).toEqual([]);
  });

  it('create every table the seed writes into', async () => {
    await expect(readPublicTables()).resolves.toEqual(MIGRATED_TABLES);
  });
});

describe('the remaining-spend meter, reading 5 400/10 000 kr', () => {
  it('stores the 10 000 kr cap as 1000000 integer minor units', async () => {
    const cap = await readValue(sql`
      SELECT sl.cap_minor_units AS value
      FROM spend_limits AS sl
      JOIN cards AS c ON c.id = sl.card_id
      WHERE c.company_id = ${SEED_COMPANY_ID}
    `);
    // Strictly a number, not the string a `bigint` or `numeric` column would
    // come back as — the drift the money columns are pinned against.
    expect(cap).toBe(MOBILE_VIEW.spendCapMinorUnits);
    expect(SEED_FIGURES.spendCapMinorUnits).toBe(MOBILE_VIEW.spendCapMinorUnits);
  });

  it('reads 540000 remaining, the 5 400 kr the screen leads with', async () => {
    const remaining = await readValue(remainingSpend(sql`${SETTLED} AND ${IN_WINDOW}`));

    expect(remaining).toBe(MOBILE_VIEW.remainingSpendMinorUnits);
    expect(SEED_FIGURES.remainingSpendMinorUnits).toBe(MOBILE_VIEW.remainingSpendMinorUnits);
  });

  it('spends 460000 of the cap, so the meter is not reading an empty account', async () => {
    const settled = await readValue(sql`
      SELECT COALESCE(SUM(tx.amount_minor_units), 0)::int AS value
      FROM transactions AS tx
      JOIN spend_limits AS sl ON sl.card_id = tx.card_id
      WHERE tx.company_id = ${SEED_COMPANY_ID} AND ${SETTLED} AND ${IN_WINDOW}
    `);

    expect(settled).toBe(SEED_FIGURES.settledInPeriodMinorUnits);
    expect(MOBILE_VIEW.spendCapMinorUnits - Number(settled))
      .toBe(MOBILE_VIEW.remainingSpendMinorUnits);
  });

  it('denominates the meter in the currency the screen prints as kr', async () => {
    // Aggregated rather than `SELECT DISTINCT ... LIMIT 1`: a second currency
    // would make summing the amounts meaningless, and reading the first row
    // back would report whichever one the planner happened to hand over.
    const currencies = await readValue(sql`
      SELECT string_agg(DISTINCT tx.currency_code, ',') AS value
      FROM transactions AS tx
      WHERE tx.company_id = ${SEED_COMPANY_ID}
    `);
    expect(currencies).toBe(MOBILE_VIEW.currencyCode);
    expect(SEED_FIGURES.currencyCode).toBe(MOBILE_VIEW.currencyCode);
  });

  it('reads 447700 for a mapper that drops the settlement filter', async () => {
    // Four in-window transactions are authorised, reversed or disputed. Without
    // this case the seed could settle all 57 and nothing here would notice.
    const remaining = await readValue(remainingSpend(IN_WINDOW));

    expect(remaining).toBe(WRONG_REMAINING_SPEND.withoutSettlementFilter);
    expect(remaining).not.toBe(MOBILE_VIEW.remainingSpendMinorUnits);
  });

  it('reads 300000 for a mapper that drops the spend-window filter', async () => {
    // Six settled transactions are booked before the window opened, which is
    // what stops every seeded row from counting towards the cap.
    const remaining = await readValue(remainingSpend(SETTLED));

    expect(remaining).toBe(WRONG_REMAINING_SPEND.withoutWindowFilter);
    expect(remaining).not.toBe(MOBILE_VIEW.remainingSpendMinorUnits);
  });

  it('round-trips the refund as a negative integer, not an absolute value', async () => {
    // Signed minor units are why `cap - SUM(settled)` needs no special case for
    // a return; a mapper taking an absolute value reads 510000 instead.
    const smallest = await readValue(sql`
      SELECT MIN(tx.amount_minor_units)::int AS value
      FROM transactions AS tx
      WHERE tx.company_id = ${SEED_COMPANY_ID}
    `);
    expect(smallest).toBe(-15_000);
  });
});

describe('the transaction list, reading 54 more items in transaction view', () => {
  it('stores 57 transactions, the three shown plus the 54 more', async () => {
    const total = await readValue(transactionCount());

    expect(total).toBe(MOBILE_VIEW_TRANSACTION_COUNT);
    expect(total).toBe(57);
    expect(SEED_FIGURES.transactionCount).toBe(MOBILE_VIEW_TRANSACTION_COUNT);
  });

  it('leaves 54 behind the three the dashboard lists', async () => {
    const further = await readValue(sql`
      SELECT (count(*) - ${MOBILE_VIEW.shownTransactionCount})::int AS value
      FROM transactions
      WHERE company_id = ${SEED_COMPANY_ID}
    `);

    expect(further).toBe(MOBILE_VIEW.furtherTransactionCount);
    expect(SEED_FIGURES.furtherTransactionCount).toBe(MOBILE_VIEW.furtherTransactionCount);
    expect(SEED_FIGURES.dashboardTransactionCount).toBe(MOBILE_VIEW.shownTransactionCount);
  });

  it('orders the three the screen lists newest first', async () => {
    // A bare `ORDER BY ... DESC`, deliberately not `DESC NULLS LAST`: the
    // index on `(company_id, booked_at)` is declared ascending and is read
    // backwards for this, which a nulls qualifier would cost. See the
    // `transactions` module header.
    const { rows } = await database.db.execute(sql`
      SELECT booked_at
      FROM transactions
      WHERE company_id = ${SEED_COMPANY_ID}
      ORDER BY booked_at DESC
      LIMIT ${MOBILE_VIEW.shownTransactionCount}
    `);
    const bookedAt = rows.map((row) => new Date(String(row.booked_at)).getTime());

    expect(bookedAt).toHaveLength(MOBILE_VIEW.shownTransactionCount);
    expect([...bookedAt].sort((left, right) => right - left)).toEqual(bookedAt);
  });

  it('shows a transaction the meter does not count, so the two figures differ', async () => {
    // The newest row of all is authorised rather than settled. It belongs in
    // the three the screen lists and not in the spend the meter subtracts,
    // which is the distinction `5 400` and `54 more` rest on.
    const newestState = await readValue(sql`
      SELECT tx.settlement_state AS value
      FROM transactions AS tx
      WHERE tx.company_id = ${SEED_COMPANY_ID}
      ORDER BY tx.booked_at DESC
      LIMIT 1
    `);
    expect(newestState).not.toBe('settled');
  });
});

describe('re-running the seed', () => {
  it('leaves the same figures and no duplicated rows', async () => {
    await seedDatabase(database.db, { now: NOW });

    await expect(readValue(transactionCount()))
      .resolves
      .toBe(MOBILE_VIEW_TRANSACTION_COUNT);
    await expect(readValue(remainingSpend(sql`${SETTLED} AND ${IN_WINDOW}`)))
      .resolves
      .toBe(MOBILE_VIEW.remainingSpendMinorUnits);
  });
});
