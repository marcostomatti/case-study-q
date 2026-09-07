/**
 * Seeds the single company the mobile view in `assets/mobile-view.png`
 * renders, and nothing else.
 *
 * Every figure below is read off that screenshot, so this module is the place
 * the demo's numbers are decided:
 *
 *   - `Company AB` in the company selector.
 *   - `5 400/10 000 kr` in the remaining-spend meter — a `1000000` minor-unit
 *     cap against `460000` of settled spend, leaving `540000`.
 *   - `54 more items in transaction view` behind three shown rows — `57`
 *     transactions for the company.
 *   - `Invoice due` — one issued invoice falling due shortly.
 *
 * ## The rows that exist to make those figures provable
 *
 * Remaining spend is `cap - SUM(settled transactions booked inside the current
 * window)`. If every seeded transaction were settled and inside the window,
 * a `dashboardMapper` that dropped either filter would still compute `540000`
 * and the integration test asserting it would prove nothing. So the 57 rows
 * are deliberately not uniform, and each group breaks a different wrong answer:
 *
 *   | group                        | rows | a mapper that ignores it reads |
 *   | ---------------------------- | ---- | ------------------------------ |
 *   | settled, inside the window   |   47 | (the correct 540000)           |
 *   | not settled, inside window   |    4 | 447700 — it summed 552300      |
 *   | settled, before the window   |    6 | 300000 — it summed 700000      |
 *
 * The 47 include one negative amount, a returned purchase, so a mapper that
 * takes an absolute value reads `510000` rather than `540000`. And the newest
 * transaction of all is `authorised` rather than `settled`: it belongs in the
 * three rows the screen lists but not in the spend the meter subtracts, which
 * is the distinction the two figures rest on.
 *
 * The same argument covers the invoice banner. A second, already-`paid`
 * invoice carries an *earlier* due date than the issued one, so a lookup
 * written `ORDER BY due_on LIMIT 1` without the `payment_state` filter
 * returns the wrong row instead of accidentally returning the right one.
 * There is still exactly one *due* invoice, which is what the screen shows.
 *
 * ## Determinism
 *
 * Amounts, counts and identifiers are fixed literals. Only the instants are
 * relative, derived from an injectable `now` that defaults to the wall clock,
 * so the invoice-due banner and the "latest" transactions stay true whenever
 * the demo is run rather than going stale on a committed date. A caller that
 * needs total determinism — the integration test — passes its own `now`.
 *
 * `period_started_at` is therefore `now` minus 30 days rather than the first
 * of the calendar month. That is a card statement cycle, not a fudge: it
 * keeps the window a fixed width whatever day the seed runs, where a
 * calendar month would collapse to a few minutes when run just after
 * midnight on the 1st and make "the three latest transactions" a tie.
 *
 * `buildSeedRows` asserts the figures above hold for the rows it just built,
 * so an edited amount fails here with a message naming the figure rather than
 * silently changing what the demo claims.
 *
 * ## Re-running it
 *
 * `seedDatabase` deletes the seeded company's own rows and re-inserts them,
 * inside one transaction. It never truncates a table and never touches a row
 * belonging to another company, so pointing it at a populated database costs
 * that one company and nothing else.
 *
 * ## Why this is not exported from `src/index.ts`
 *
 * `src/index.ts` is the `schema` entry of `drizzle.config.ts`, and
 * drizzle-kit bundles and executes it for its exports. Re-exporting a module
 * that opens a connection from there would put a database driver on the path
 * of `bun run db:generate`, which contacts no database by design. The seed is
 * reachable as `@marcos-corp/db/seed` instead, and directly as
 * `bun run db:seed`.
 */
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { cards, type NewCard } from './schema/cards';
import { companies, type NewCompany } from './schema/companies';
import { invoices, type NewInvoice } from './schema/invoices';
import { spendLimits, type NewSpendLimit } from './schema/spendLimits';
import {
  transactions,
  type NewTransaction,
  type TransactionSettlementState,
} from './schema/transactions';

/**
 * The numbers the mobile view renders, in the units the schema stores them.
 *
 * Exported because the integration test asserts them against what it reads
 * back out of Postgres. It must not read the figures off the row builder —
 * that agrees with itself whatever the seed inserted.
 */
export const SEED_FIGURES = {
  /** `10 000 kr`, the "based on your set limit" half of the meter. */
  spendCapMinorUnits: 1_000_000,
  /** Settled spend inside the current window. */
  settledInPeriodMinorUnits: 460_000,
  /** `5 400 kr`, the figure the meter leads with. */
  remainingSpendMinorUnits: 540_000,
  currencyCode: 'SEK',
  /** Every transaction the company owns, across every state and both windows. */
  transactionCount: 57,
  /** Rows under "Latest transactions". */
  dashboardTransactionCount: 3,
  /** `54 more items in transaction view`. */
  furtherTransactionCount: 54,
  /** The due one the banner shows, plus the paid one that makes it provable. */
  invoiceCount: 2,
  dueInvoiceCount: 1,
} as const;

/** Fixed so the demo, the acceptance scripts and the tests name the same rows. */
export const SEED_COMPANY_ID = '11111111-1111-4111-8111-111111111111';
export const SEED_CARD_ID = '22222222-2222-4222-8222-222222222222';
export const SEED_DUE_INVOICE_ID = '33333333-3333-4333-8333-333333333333';
export const SEED_PAID_INVOICE_ID = '44444444-4444-4444-8444-444444444444';

const TRANSACTION_ID_PREFIX = '55555555-5555-4555-8555-';
const TRANSACTION_ID_SUFFIX_LENGTH = 12;

const MILLISECONDS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 1_440;
const ISO_DATE_LENGTH = 10;

/** The width of the spend window `period_started_at` opens. See the header. */
const SPEND_WINDOW_DAYS = 30;
/** 12 h between consecutive transactions, so 51 in-window rows span ~25 days. */
const TRANSACTION_SPACING_MINUTES = 720;
/** How far back the newest transaction sits, so none is booked in the future. */
const NEWEST_TRANSACTION_OFFSET_MINUTES = 45;

const DUE_INVOICE_DAYS_AHEAD = 12;
const PAID_INVOICE_DAYS_BEHIND = 20;

/**
 * One row, or `count` identical rows differing only in booking time.
 *
 * Grouping by count keeps 51 in-window transactions legible as 13 lines whose
 * subtotals a reader can add up, rather than as 51 near-identical literals.
 */
interface TransactionSpec {
  merchantName: string;
  /** ISO-18245, exactly four digits — a raw code, not the contract's enum. */
  merchantCategoryCode: string;
  /** Signed minor units. Negative is a refund. */
  amountMinorUnits: number;
  settlementState: TransactionSettlementState;
  count: number;
}

/**
 * Builds a spec positionally, so a table of them stays one row per line and
 * its subtotals can be added up by eye: merchant, MCC, minor units, state,
 * how many rows.
 */
function txSpec(
  merchantName: string,
  merchantCategoryCode: string,
  amountMinorUnits: number,
  settlementState: TransactionSettlementState,
  count: number,
): TransactionSpec {
  return { merchantName, merchantCategoryCode, amountMinorUnits, settlementState, count };
}

/**
 * Transactions inside the current spend window, newest first.
 *
 * The settled rows sum to `SEED_FIGURES.settledInPeriodMinorUnits`:
 * `12x4500 + 10x6500 - 15000 + 8x8900 + 6x12500 + 4x18000 + 3x24900 +
 * 2x27000 + 9100 = 460000` across 47 rows. The four that are not settled are
 * what stops a mapper that forgets the state filter from reaching the same
 * answer, and their placement is deliberate: an `authorised` hotel and fuel
 * pre-authorisation are the two newest rows, a duplicate charge is `reversed`
 * mid-window, and a chargeback sits further back as `disputed`, because
 * disputes take time to raise.
 */
const IN_WINDOW_TRANSACTIONS: readonly TransactionSpec[] = [
  txSpec('Scandic Malmo', '7011', 22_000, 'authorised', 1),
  txSpec('Circle K Solna', '5541', 6_400, 'authorised', 1),
  txSpec('Pressbyran Odenplan', '5499', 4_500, 'settled', 12),
  txSpec('SL Reskassa', '4111', 6_500, 'settled', 10),
  // The refund. Signed minor units are why `cap - SUM(settled)` needs no
  // special case for a return, and why an absolute value reads 510000.
  txSpec('Clas Ohlson Retur', '5200', -15_000, 'settled', 1),
  txSpec('Espresso House', '5814', 8_900, 'settled', 8),
  txSpec('Nordic Cloud Hosting', '7372', 45_000, 'reversed', 1),
  txSpec('Circle K Solna', '5541', 12_500, 'settled', 6),
  txSpec('Clas Ohlson', '5200', 18_000, 'settled', 4),
  txSpec('Telia Foretag', '4814', 18_900, 'disputed', 1),
  txSpec('Nordic Cloud Hosting', '7372', 24_900, 'settled', 3),
  txSpec('SJ Regional', '4112', 27_000, 'settled', 2),
  txSpec('Elite Hotel Stockholm', '7011', 9_100, 'settled', 1),
];

/**
 * Transactions booked before the window opened, newest first. All settled, and
 * all excluded from the meter: they sum to 240000, so a mapper that drops the
 * window filter reads 300000 remaining instead of 540000.
 *
 * They also give the paginated transaction view something to page into that
 * the dashboard's own figures do not account for, which is the shape a real
 * account has.
 */
const BEFORE_WINDOW_TRANSACTIONS: readonly TransactionSpec[] = [
  txSpec('Elite Hotel Stockholm', '7011', 66_700, 'settled', 1),
  txSpec('Clas Ohlson', '5200', 66_000, 'settled', 1),
  txSpec('Nordic Cloud Hosting', '7372', 24_900, 'settled', 1),
  txSpec('Circle K Solna', '5541', 42_500, 'settled', 1),
  txSpec('Espresso House', '5814', 8_900, 'settled', 1),
  txSpec('SJ Regional', '4112', 31_000, 'settled', 1),
];

/** Every row `seedDatabase` writes, in the order the foreign keys allow. */
export interface SeedRows {
  company: NewCompany;
  card: NewCard;
  spendLimit: NewSpendLimit;
  /** Newest first, so `slice(0, 3)` is what the dashboard lists. */
  transactions: NewTransaction[];
  invoices: NewInvoice[];
}

/** Options accepted by `buildSeedRows` and `seedDatabase`. */
export interface SeedOptions {
  /**
   * The instant every seeded timestamp is measured back from. Defaults to the
   * wall clock, truncated to the second; pass one to make a run reproducible.
   */
  now?: Date;
}

function shiftMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MILLISECONDS_PER_MINUTE);
}

/** The UTC calendar day, which is what a `date` column holds. */
function calendarDay(instant: Date): string {
  return instant.toISOString().slice(0, ISO_DATE_LENGTH);
}

function transactionId(oneBasedIndex: number): string {
  const suffix = String(oneBasedIndex).padStart(TRANSACTION_ID_SUFFIX_LENGTH, '0');
  return `${TRANSACTION_ID_PREFIX}${suffix}`;
}

/** Expands the grouped specs into one entry per row, preserving order. */
function expand(specs: readonly TransactionSpec[]): TransactionSpec[] {
  return specs.flatMap((spec) => Array.from({ length: spec.count }, () => spec));
}

/**
 * A broken invariant is a broken demo, so it stops the seed rather than
 * reaching Postgres. The message names the figure, not the line.
 */
function assertSeedInvariant(holds: boolean, what: string): void {
  if (!holds) {
    throw new Error(`seed is inconsistent: ${what}`);
  }
}

/**
 * Builds every row the seed inserts, without touching a database.
 *
 * Pure and side-effect free, so the integration test can compare what it read
 * back out of Postgres against what was supposed to go in.
 */
export function buildSeedRows(options: SeedOptions = {}): SeedRows {
  // Truncate to the second: `timestamptz` keeps sub-second precision, and a
  // seeded instant that differs from the built one only in milliseconds makes
  // an equality assertion fail for a reason nobody meant to test.
  const source = options.now ?? new Date();
  const now = new Date(Math.floor(source.getTime() / 1000) * 1000);
  const periodStartedAt = shiftMinutes(now, -SPEND_WINDOW_DAYS * MINUTES_PER_DAY);

  const company: NewCompany = {
    id: SEED_COMPANY_ID,
    // Separate facts, not a formatting difference: the selector shows the
    // display name, an invoice carries the registered one.
    registeredLegalName: 'Company Sverige Aktiebolag',
    displayName: 'Company AB',
    organisationNumber: '556677-8899',
    defaultCurrencyCode: SEED_FIGURES.currencyCode,
  };

  const card: NewCard = {
    id: SEED_CARD_ID,
    companyId: SEED_COMPANY_ID,
    panLastFour: '4321',
    // `issued`, not `active`, so the screen's "Activate card" button has
    // something to do — and so the card mapper has to omit `activatedAt`
    // rather than emit a `null` for it (spec §2.5).
    lifecycleStatus: 'issued',
    artAssetKey: 'card-art/business-black-v2',
  };

  const spendLimit: NewSpendLimit = {
    cardId: SEED_CARD_ID,
    capMinorUnits: SEED_FIGURES.spendCapMinorUnits,
    resetPeriod: 'monthly',
    periodStartedAt,
  };

  const inWindow = expand(IN_WINDOW_TRANSACTIONS);
  const beforeWindow = expand(BEFORE_WINDOW_TRANSACTIONS);

  const transactionRows: NewTransaction[] = [
    ...inWindow.map((spec, index) => ({
      spec,
      bookedAt: shiftMinutes(
        now,
        -(NEWEST_TRANSACTION_OFFSET_MINUTES + index * TRANSACTION_SPACING_MINUTES),
      ),
    })),
    ...beforeWindow.map((spec, index) => ({
      spec,
      bookedAt: shiftMinutes(
        periodStartedAt,
        -(index + 1) * TRANSACTION_SPACING_MINUTES,
      ),
    })),
  ].map(({ spec, bookedAt }, index) => ({
    id: transactionId(index + 1),
    cardId: SEED_CARD_ID,
    // Denormalised, and the database does not enforce that it matches the
    // card's company — see the `transactions` module header. Holding that
    // invariant is the writer's job, and this is one of the writers.
    companyId: SEED_COMPANY_ID,
    bookedAt,
    amountMinorUnits: spec.amountMinorUnits,
    currencyCode: SEED_FIGURES.currencyCode,
    merchantName: spec.merchantName,
    merchantCategoryCode: spec.merchantCategoryCode,
    settlementState: spec.settlementState,
  }));

  const invoiceRows: NewInvoice[] = [
    {
      id: SEED_DUE_INVOICE_ID,
      companyId: SEED_COMPANY_ID,
      dueOn: calendarDay(shiftMinutes(now, DUE_INVOICE_DAYS_AHEAD * MINUTES_PER_DAY)),
      totalMinorUnits: 248_000,
      currencyCode: SEED_FIGURES.currencyCode,
      paymentState: 'issued',
    },
    {
      // Settled, and due *earlier* than the issued one on purpose: a
      // due-invoice lookup that forgets `payment_state = 'issued'` returns
      // this row, so the banner is wrong rather than accidentally right.
      id: SEED_PAID_INVOICE_ID,
      companyId: SEED_COMPANY_ID,
      dueOn: calendarDay(shiftMinutes(now, -PAID_INVOICE_DAYS_BEHIND * MINUTES_PER_DAY)),
      totalMinorUnits: 132_500,
      currencyCode: SEED_FIGURES.currencyCode,
      paymentState: 'paid',
    },
  ];

  const settledInPeriod = transactionRows
    .filter((row) => row.settlementState === 'settled' && row.bookedAt >= periodStartedAt)
    .reduce((total, row) => total + row.amountMinorUnits, 0);

  assertSeedInvariant(
    transactionRows.length === SEED_FIGURES.transactionCount,
    `expected ${SEED_FIGURES.transactionCount} transactions, built ${transactionRows.length}`,
  );
  assertSeedInvariant(
    SEED_FIGURES.dashboardTransactionCount + SEED_FIGURES.furtherTransactionCount
      === SEED_FIGURES.transactionCount,
    'the three shown transactions plus the further ones must be the total',
  );
  // Placement is checked before the sums it feeds. A row on the wrong side of
  // the window changes the settled total too, and "expected 460000, built
  // 412300" would send a reader looking for a typo in an amount.
  assertSeedInvariant(
    transactionRows.slice(0, inWindow.length).every((row) => row.bookedAt >= periodStartedAt),
    'every in-window transaction must be booked on or after the window opened',
  );
  assertSeedInvariant(
    transactionRows.slice(inWindow.length).every((row) => row.bookedAt < periodStartedAt),
    'every before-window transaction must be booked before the window opened',
  );
  assertSeedInvariant(
    transactionRows.every((row) => row.bookedAt <= now),
    'no transaction may be booked in the future',
  );
  assertSeedInvariant(
    settledInPeriod === SEED_FIGURES.settledInPeriodMinorUnits,
    `expected ${SEED_FIGURES.settledInPeriodMinorUnits} settled in the window, built ${settledInPeriod}`,
  );
  assertSeedInvariant(
    SEED_FIGURES.spendCapMinorUnits - settledInPeriod === SEED_FIGURES.remainingSpendMinorUnits,
    `remaining spend must read ${SEED_FIGURES.remainingSpendMinorUnits} of ${SEED_FIGURES.spendCapMinorUnits}`,
  );
  assertSeedInvariant(
    invoiceRows.length === SEED_FIGURES.invoiceCount
      && invoiceRows.filter((row) => row.paymentState === 'issued').length
        === SEED_FIGURES.dueInvoiceCount,
    `expected ${SEED_FIGURES.dueInvoiceCount} due invoice of ${SEED_FIGURES.invoiceCount}`,
  );

  return { company, card, spendLimit, transactions: transactionRows, invoices: invoiceRows };
}

/**
 * Replaces the seeded company and everything hanging off it.
 *
 * One transaction, so a failure part-way leaves the database as it was rather
 * than with a company whose transactions did not land. The deletes are scoped
 * to `SEED_COMPANY_ID` and ordered child-first, because every foreign key in
 * this schema is `RESTRICT` apart from `spend_limits`, which cascades from the
 * card.
 */
export async function seedDatabase(
  db: NodePgDatabase,
  options: SeedOptions = {},
): Promise<SeedRows> {
  const rows = buildSeedRows(options);

  await db.transaction(async (tx) => {
    await tx.delete(transactions).where(eq(transactions.companyId, SEED_COMPANY_ID));
    await tx.delete(invoices).where(eq(invoices.companyId, SEED_COMPANY_ID));
    // Cascades to `spend_limits`; nothing else references a card.
    await tx.delete(cards).where(eq(cards.companyId, SEED_COMPANY_ID));
    await tx.delete(companies).where(eq(companies.id, SEED_COMPANY_ID));

    await tx.insert(companies).values(rows.company);
    await tx.insert(cards).values(rows.card);
    await tx.insert(spendLimits).values(rows.spendLimit);
    await tx.insert(transactions).values(rows.transactions);
    await tx.insert(invoices).values(rows.invoices);
  });

  return rows;
}

/**
 * Renders a thrown value as something an operator can act on.
 *
 * `err.message` alone is not enough here: `pg` reports a refused connection —
 * the likeliest way this CLI fails — as an `AggregateError` whose own message
 * is the empty string, so the naive version prints `FAIL — ` and says nothing.
 * The individual causes carry the `ECONNREFUSED <host>:<port>` text.
 */
function describeError(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0) {
    return err.errors.map((cause) => describeError(cause)).join('; ');
  }
  if (err instanceof Error) {
    return err.message || err.name;
  }
  return String(err);
}

/**
 * `bun run db:seed`.
 *
 * Reads `DATABASE_URL` and refuses without it. There is no fallback
 * connection string here for the same reason `drizzle.config.ts` carries
 * none: a default is how a seed ends up applied to whatever database happened
 * to be listening.
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('[db:seed] FAIL — DATABASE_URL is not set.');
    process.exit(2);
  }

  const pool = new Pool({ connectionString });
  try {
    const rows = await seedDatabase(drizzle({ client: pool }));
    console.log(
      `[db:seed] OK — ${rows.company.displayName}, ${rows.transactions.length} transactions, ` +
        `${SEED_FIGURES.remainingSpendMinorUnits} of ${SEED_FIGURES.spendCapMinorUnits} ` +
        `${SEED_FIGURES.currencyCode} minor units remaining, ${rows.invoices.length} invoices.`,
    );
  } catch (err) {
    console.error(`[db:seed] FAIL — ${describeError(err)}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Runs only when invoked directly, never when imported. `import.meta.url` is a
// file:// URL and `process.argv[1]` is a plain path, so the comparison needs
// the conversion — without it the guard is always false and the CLI silently
// does nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
