/**
 * Runtime suite for the seed's row builder. No database: `buildSeedRows` is
 * pure, and every claim below is about the rows it hands `seedDatabase`.
 *
 * The database-backed half — migrate, seed, read the figures back out of SQL —
 * is a separate integration suite, because it needs a Postgres this one must
 * not require. The split matters when reading a green run here: this file
 * proves the seed *builds* `5 400/10 000 kr` and 57 transactions; it cannot
 * prove they survived an insert.
 *
 * The discrimination cases are the point of the file. Asserting only that
 * remaining spend is 540000 passes just as well against a seed where every
 * transaction is settled and inside the window — and such a seed would let a
 * `dashboardMapper` that drops either filter score full marks. Each case below
 * therefore names the wrong figure a specific missing filter produces, so the
 * seed stops being able to go quietly uniform.
 */
import { describe, expect, it } from 'vitest';

import { buildSeedRows, SEED_CARD_ID, SEED_COMPANY_ID, SEED_FIGURES } from './seed';

/** Fixed, so every case reasons about the same instants. */
const NOW = new Date('2026-09-08T12:00:00.000Z');

const rows = buildSeedRows({ now: NOW });
const periodStartedAt = rows.spendLimit.periodStartedAt;

function sum(amounts: readonly number[]): number {
  return amounts.reduce((total, amount) => total + amount, 0);
}

/** Remaining spend under a given transaction filter, as a mapper would read it. */
function remainingUnder(keep: (row: (typeof rows.transactions)[number]) => boolean): number {
  return SEED_FIGURES.spendCapMinorUnits
    - sum(rows.transactions.filter(keep).map((row) => row.amountMinorUnits));
}

const isSettled = (row: (typeof rows.transactions)[number]): boolean => row.settlementState === 'settled';
const isInWindow = (row: (typeof rows.transactions)[number]): boolean => row.bookedAt >= periodStartedAt;

describe('the company selector', () => {
  it('names the company the mobile view shows', () => {
    expect(rows.company.displayName).toBe('Company AB');
  });

  it('keeps the registered legal name a separate fact from the display name', () => {
    expect(rows.company.registeredLegalName).not.toBe(rows.company.displayName);
  });

  it('denominates the company in the currency the meter renders', () => {
    expect(rows.company.defaultCurrencyCode).toBe('SEK');
  });
});

describe('the card', () => {
  it('is issued rather than active, so "Activate card" has something to do', () => {
    expect(rows.card.lifecycleStatus).toBe('issued');
  });

  it('carries no activation instant, so the mapper must omit the field', () => {
    // Spec §2.5: `null` is never emitted and absent means not applicable. A
    // card that arrived already activated would never exercise that path.
    expect(rows.card.activatedAt).toBeUndefined();
  });
});

describe('the remaining-spend meter', () => {
  it('reads 540000 of 1000000, the screen\'s 5 400/10 000 kr', () => {
    expect(remainingUnder((row) => isSettled(row) && isInWindow(row)))
      .toBe(SEED_FIGURES.remainingSpendMinorUnits);
    expect(SEED_FIGURES.remainingSpendMinorUnits).toBe(540_000);
    expect(SEED_FIGURES.spendCapMinorUnits).toBe(1_000_000);
  });

  it('reads 447700 for a mapper that forgets the settlement filter', () => {
    // 4 in-window rows are authorised, reversed or disputed. Without this
    // case the seed could settle all 57 and this suite would not notice.
    expect(remainingUnder(isInWindow)).toBe(447_700);
    expect(remainingUnder(isInWindow)).not.toBe(SEED_FIGURES.remainingSpendMinorUnits);
  });

  it('reads 300000 for a mapper that forgets the spend window', () => {
    // 6 settled rows are booked before the window opened, summing to 240000.
    expect(remainingUnder(isSettled)).toBe(300_000);
    expect(remainingUnder(isSettled)).not.toBe(SEED_FIGURES.remainingSpendMinorUnits);
  });

  it('reads 510000 for a mapper that takes the absolute value of an amount', () => {
    const settledInWindow = rows.transactions.filter((row) => isSettled(row) && isInWindow(row));
    const absolute = SEED_FIGURES.spendCapMinorUnits
      - sum(settledInWindow.map((row) => Math.abs(row.amountMinorUnits)));
    expect(absolute).toBe(510_000);
    expect(absolute).not.toBe(SEED_FIGURES.remainingSpendMinorUnits);
  });

  it('includes exactly one refund, which is what makes the sign load-bearing', () => {
    const refunds = rows.transactions.filter((row) => row.amountMinorUnits < 0);
    expect(refunds).toHaveLength(1);
  });
});

describe('the transaction list', () => {
  it('holds 57 rows, so three shown leaves 54 more items', () => {
    expect(rows.transactions).toHaveLength(SEED_FIGURES.transactionCount);
    expect(SEED_FIGURES.transactionCount - SEED_FIGURES.dashboardTransactionCount)
      .toBe(SEED_FIGURES.furtherTransactionCount);
    expect(SEED_FIGURES.furtherTransactionCount).toBe(54);
  });

  it('is ordered strictly newest first, so the three latest are not a tie', () => {
    const bookedAt = rows.transactions.map((row) => row.bookedAt.getTime());
    expect(bookedAt.every((instant, i) => i === 0 || bookedAt[i - 1]! > instant)).toBe(true);
  });

  it('books nothing in the future', () => {
    expect(rows.transactions.every((row) => row.bookedAt <= NOW)).toBe(true);
  });

  it('gives every row a distinct id', () => {
    expect(new Set(rows.transactions.map((row) => row.id)).size).toBe(rows.transactions.length);
  });

  it('leads with a transaction that is listed but does not reduce remaining spend', () => {
    // The distinction the two figures on the screen rest on: the newest row
    // belongs in "Latest transactions" and not in the settled spend.
    const [newest] = rows.transactions;
    expect(newest?.settlementState).toBe('authorised');
  });

  it('hangs every row off the seeded company and card', () => {
    expect(rows.transactions.every((row) => row.companyId === SEED_COMPANY_ID)).toBe(true);
    // The database does not enforce that `company_id` matches the card's
    // company — see the `transactions` module header. The seed is one of the
    // writers holding that invariant, so it is asserted here.
    expect(rows.transactions.every((row) => row.cardId === SEED_CARD_ID)).toBe(true);
  });

  it('prices every row in the currency the meter renders', () => {
    expect(new Set(rows.transactions.map((row) => row.currencyCode))).toEqual(new Set(['SEK']));
  });
});

describe('the invoice-due banner', () => {
  it('has exactly one due invoice', () => {
    const due = rows.invoices.filter((row) => row.paymentState === 'issued');
    expect(due).toHaveLength(SEED_FIGURES.dueInvoiceCount);
    expect(rows.invoices).toHaveLength(SEED_FIGURES.invoiceCount);
  });

  it('falls due after today, so the banner is live whenever the demo runs', () => {
    const due = rows.invoices.find((row) => row.paymentState === 'issued');
    expect(due?.dueOn).toBe('2026-09-20');
    expect(due!.dueOn > NOW.toISOString().slice(0, 10)).toBe(true);
  });

  it('is not the invoice a lookup that forgets the payment state would find', () => {
    // The paid invoice is due EARLIER on purpose. Without it, a due-invoice
    // query written `ORDER BY due_on LIMIT 1` with no state filter would be
    // accidentally right, and this seed would not catch it.
    const earliest = [...rows.invoices].sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0];
    expect(earliest?.paymentState).toBe('paid');
  });
});

describe('determinism', () => {
  it('builds identical rows for the same instant', () => {
    expect(buildSeedRows({ now: NOW })).toEqual(buildSeedRows({ now: NOW }));
  });

  it('moves every instant with `now` but changes none of the figures', () => {
    const later = buildSeedRows({ now: new Date('2027-03-01T08:30:00.000Z') });

    expect(later.transactions[0]!.bookedAt).not.toEqual(rows.transactions[0]!.bookedAt);
    expect(later.invoices[0]!.dueOn).not.toEqual(rows.invoices[0]!.dueOn);

    expect(later.transactions).toHaveLength(SEED_FIGURES.transactionCount);
    expect(later.transactions.map((row) => row.amountMinorUnits))
      .toEqual(rows.transactions.map((row) => row.amountMinorUnits));
    expect(later.spendLimit.capMinorUnits).toBe(SEED_FIGURES.spendCapMinorUnits);
  });

  it('opens the spend window a fixed width before `now`, never on a calendar boundary', () => {
    // A calendar-month window collapses to minutes when the seed runs just
    // after midnight on the 1st, which makes "the three latest" a tie.
    const MILLISECONDS_PER_DAY = 86_400_000;
    expect(NOW.getTime() - periodStartedAt.getTime()).toBe(30 * MILLISECONDS_PER_DAY);
  });

  it('truncates a sub-second `now` so a round-tripped instant compares equal', () => {
    const ragged = buildSeedRows({ now: new Date('2026-09-08T12:00:00.777Z') });
    expect(ragged.spendLimit.periodStartedAt.getMilliseconds()).toBe(0);
    expect(ragged.transactions.every((row) => row.bookedAt.getMilliseconds() === 0)).toBe(true);
  });
});
