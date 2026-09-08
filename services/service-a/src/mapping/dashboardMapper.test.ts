/**
 * Runtime suite for `dashboardMapper.ts`.
 *
 * The module assembles one payload out of four independently-fetched rows, and
 * the claims it makes are separable:
 *
 * - **The remaining figure is `cap - SUM(settled, in window)`.** Two filters,
 *   each of which a mapper could plausibly drop, and each of which the seeded
 *   data is arranged to make visible: dropping the settlement filter answers
 *   `447700`, dropping the window filter answers `300000`, and taking the
 *   magnitude of the refund answers `510000`. All three are distinct from the
 *   correct `540000`, which is what lets a case tell them apart.
 * - **The screen's two derived numbers come out right for the seeded demo**:
 *   `5 400/10 000 kr` and `54 more items in transaction view`, both read off
 *   `assets/mobile-view.png`.
 * - **The listed transactions are the newest three, newest first**, which this
 *   module holds rather than trusting the caller to have ordered its query.
 * - **The company row is folded, not passed through.** Two of its five columns
 *   reach the payload; a schema derived from the table would publish all five.
 * - **Four rows that do not belong together are refused**, rather than
 *   producing a meter for one card measured against another card's cap.
 *
 * Two shapes recur, for the reason the neighbouring mapper suites give. A case
 * asserting a row was excluded from the sum passes just as well against a
 * mapper that excludes everything, so every exclusion sits beside an inclusion
 * in the same fixture; and a case asserting something was refused is paired
 * with a control that must still succeed.
 */
import type {
  Card as CardRow,
  Company as CompanyRow,
  NewCard,
  NewCompany,
  NewTransaction,
  SpendLimit as SpendLimitRow,
  Transaction as TransactionRow,
} from '@marcos-corp/db';

import { DASHBOARD_TRANSACTION_COUNT } from '@marcos-corp/contracts-service-a';
import { buildSeedRows, SEED_FIGURES } from '@marcos-corp/db/seed';
import { describe, expect, it } from 'vitest';

import { settledSpendMinorUnits, toCompanySummary, toDashboard } from './dashboardMapper';

/** Where `server.ts` will say card artwork is served from. */
const ART_BASE_URL = 'https://cdn.example.com/assets';

/** The instant the current spend window opened, for the hand-built fixtures. */
const WINDOW_OPENED_AT = new Date('2026-08-09T12:00:00.000Z');

const MILLISECONDS_PER_MINUTE = 60_000;

/** The seeded company, as a query returns it. */
const COMPANY: CompanyRow = {
  id: '11111111-1111-4111-8111-111111111111',
  registeredLegalName: 'Company Sverige Aktiebolag',
  displayName: 'Company AB',
  organisationNumber: '556677-8899',
  defaultCurrencyCode: 'SEK',
};

/** The seeded card, in the state `packages/db` leaves it: issued, not activated. */
const CARD: CardRow = {
  id: '22222222-2222-4222-8222-222222222222',
  companyId: COMPANY.id,
  panLastFour: '4321',
  lifecycleStatus: 'issued',
  activatedAt: null,
  artAssetKey: 'card-art/business-black-v2',
};

/** `10 000 kr`, the "based on your set limit" half of the meter. */
const SPEND_LIMIT: SpendLimitRow = {
  cardId: CARD.id,
  capMinorUnits: 1_000_000,
  resetPeriod: 'monthly',
  periodStartedAt: WINDOW_OPENED_AT,
};

/**
 * A transaction placed relative to the window, so a case says which side of it
 * the row sits on rather than restating an instant.
 */
function transactionAt(
  minutesFromWindowStart: number,
  amountMinorUnits: number,
  settlementState: TransactionRow['settlementState'],
): TransactionRow {
  const bookedAt = new Date(
    WINDOW_OPENED_AT.getTime() + minutesFromWindowStart * MILLISECONDS_PER_MINUTE,
  );

  return {
    id: `55555555-5555-4555-8555-${String(minutesFromWindowStart + 1_000_000).padStart(12, '0')}`,
    cardId: CARD.id,
    companyId: COMPANY.id,
    bookedAt,
    amountMinorUnits,
    currencyCode: 'SEK',
    merchantName: 'Espresso House',
    merchantCategoryCode: '5814',
    settlementState,
  };
}

/** Everything `toDashboard` needs, with the parts a case varies overridden. */
function sourcesWith(overrides: {
  company?: CompanyRow;
  card?: CardRow;
  spendLimit?: SpendLimitRow;
  transactions?: readonly TransactionRow[];
  transactionCount?: number;
}) {
  const transactions = overrides.transactions ?? [];

  return {
    company: overrides.company ?? COMPANY,
    card: overrides.card ?? CARD,
    spendLimit: overrides.spendLimit ?? SPEND_LIMIT,
    transactions,
    transactionCount: overrides.transactionCount ?? transactions.length,
  };
}

/**
 * `buildSeedRows` hands back insert rows, whose generated columns are optional
 * in the type. The seed fills every one of them, and these three state that
 * rather than casting it away — a seed that stopped fixing its ids would fail
 * here instead of producing a row with an `undefined` id.
 */
function asCompanyRow(row: NewCompany): CompanyRow {
  const { id } = row;

  if (id === undefined) {
    throw new Error('the seed must fix the company id');
  }

  return { ...row, id };
}

function asCardRow(row: NewCard): CardRow {
  const { id } = row;

  if (id === undefined) {
    throw new Error('the seed must fix the card id');
  }

  return { ...row, id, activatedAt: row.activatedAt ?? null };
}

function asTransactionRow(row: NewTransaction): TransactionRow {
  const { id } = row;

  if (id === undefined) {
    throw new Error('the seed must fix every transaction id');
  }

  return { ...row, id };
}

/** The demo's rows, at a fixed instant so the windows are reproducible. */
function seededSources() {
  const rows = buildSeedRows({ now: new Date('2026-09-08T12:00:00.000Z') });

  return {
    company: asCompanyRow(rows.company),
    card: asCardRow(rows.card),
    spendLimit: rows.spendLimit,
    transactions: rows.transactions.map(asTransactionRow),
    transactionCount: rows.transactions.length,
  };
}

describe('toCompanySummary', () => {
  it('publishes the display name and the id, and nothing else', () => {
    expect(toCompanySummary(COMPANY)).toStrictEqual({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Company AB',
    });
  });

  /**
   * Named individually as well as covered by the whole-shape case above,
   * because these are the columns a schema derived from `companies` would have
   * published — the registered legal name in particular is a different fact
   * from the display name, not a formatting variant of it.
   */
  it.each([
    'registeredLegalName',
    'organisationNumber',
    'defaultCurrencyCode',
  ])('does not publish the database field %s', (field) => {
    expect(field in toCompanySummary(COMPANY)).toBe(false);
  });

  it('publishes the display name even when the legal name differs entirely', () => {
    const summary = toCompanySummary({
      ...COMPANY,
      displayName: 'Nordic Retail',
      registeredLegalName: 'Nordic Retail Holding Aktiebolag',
    });

    expect(summary.name).toBe('Nordic Retail');
  });
});

describe('settledSpendMinorUnits', () => {
  it('sums the settled transactions booked inside the window', () => {
    const spend = settledSpendMinorUnits([
      transactionAt(10, 30_000, 'settled'),
      transactionAt(20, 12_000, 'settled'),
    ], WINDOW_OPENED_AT);

    expect(spend).toBe(42_000);
  });

  /**
   * The settlement filter, stated with an included row beside every excluded
   * one. Without the inclusion the case passes against a function that returns
   * zero for everything.
   */
  it.each([
    ['authorised', 'authorised'],
    ['reversed', 'reversed'],
    ['disputed', 'disputed'],
  ])('leaves a transaction in state %s out of the spend', (_label, state) => {
    const spend = settledSpendMinorUnits([
      transactionAt(10, 30_000, 'settled'),
      transactionAt(20, 70_000, state as TransactionRow['settlementState']),
    ], WINDOW_OPENED_AT);

    expect(spend).toBe(30_000);
  });

  it('leaves a state this build has never heard of out of the spend', () => {
    const spend = settledSpendMinorUnits([
      transactionAt(10, 30_000, 'settled'),
      transactionAt(20, 70_000, 'chargeback_reversed' as TransactionRow['settlementState']),
    ], WINDOW_OPENED_AT);

    expect(spend).toBe(30_000);
  });

  /** The window filter, with the same inclusion-beside-exclusion shape. */
  it('leaves a settled transaction booked before the window out of the spend', () => {
    const spend = settledSpendMinorUnits([
      transactionAt(10, 30_000, 'settled'),
      transactionAt(-1, 70_000, 'settled'),
    ], WINDOW_OPENED_AT);

    expect(spend).toBe(30_000);
  });

  /** The boundary is inclusive: a row booked as the window opened counts. */
  it('counts a transaction booked at the instant the window opened', () => {
    const spend = settledSpendMinorUnits(
      [transactionAt(0, 30_000, 'settled')],
      WINDOW_OPENED_AT,
    );

    expect(spend).toBe(30_000);
  });

  /**
   * The signed-minor-units convention. Taking the magnitude here is the third
   * of the three plausible wrong answers the seed is arranged to separate.
   */
  it('subtracts a refund rather than adding its magnitude', () => {
    const spend = settledSpendMinorUnits([
      transactionAt(10, 30_000, 'settled'),
      transactionAt(20, -15_000, 'settled'),
    ], WINDOW_OPENED_AT);

    expect(spend).toBe(15_000);
  });

  it('reports no spend at all for a card that has never been used', () => {
    expect(settledSpendMinorUnits([], WINDOW_OPENED_AT)).toBe(0);
  });
});

describe('toDashboard', () => {
  /**
   * The whole payload at once. A per-field check passes just as happily when a
   * database column starts leaking into the response, and the four rows this
   * function is handed carry a dozen of them.
   */
  it('publishes the contract shape and nothing else', () => {
    const dashboard = toDashboard(
      sourcesWith({ transactions: [transactionAt(10, 30_000, 'settled')] }),
      { artBaseUrl: ART_BASE_URL },
    );

    expect(dashboard).toStrictEqual({
      company: {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Company AB',
      },
      card: {
        id: '22222222-2222-4222-8222-222222222222',
        lastFour: '4321',
        state: 'inactive',
        artUrl: 'https://cdn.example.com/assets/card-art/business-black-v2.png',
      },
      spend: {
        remaining: { minorUnits: 970_000, currency: 'SEK' },
        limit: { minorUnits: 1_000_000, currency: 'SEK' },
      },
      latestTransactions: [
        {
          id: '55555555-5555-4555-8555-000001000010',
          bookedAt: '2026-08-09T12:10:00.000Z',
          merchantName: 'Espresso House',
          merchantCategory: 'dining',
          amount: { minorUnits: 30_000, currency: 'SEK' },
          settlementState: 'completed',
        },
      ],
      furtherTransactionCount: 0,
    });
  });

  /**
   * Both figures take the owning company's currency. `spend_limits` stores no
   * currency column on purpose, so this is the only place the meter's ISO-4217
   * code can come from.
   */
  it('denominates both spend figures in the company default currency', () => {
    const dashboard = toDashboard(
      sourcesWith({
        company: { ...COMPANY, defaultCurrencyCode: 'NOK' },
        transactions: [transactionAt(10, 30_000, 'settled')],
      }),
      { artBaseUrl: ART_BASE_URL },
    );

    expect(dashboard.spend.remaining.currency).toBe('NOK');
    expect(dashboard.spend.limit.currency).toBe('NOK');
  });

  /**
   * An overrun reports a negative remaining figure rather than a clamped zero
   * that hides it, which is what `SpendSummary` promises by making the field a
   * signed `MonetaryAmount`.
   */
  it('reports a negative remaining figure when settled spend overruns the cap', () => {
    const dashboard = toDashboard(
      sourcesWith({ transactions: [transactionAt(10, 1_200_000, 'settled')] }),
      { artBaseUrl: ART_BASE_URL },
    );

    expect(dashboard.spend.remaining.minorUnits).toBe(-200_000);
  });

  it('lists the newest transactions first, whatever order it was handed them', () => {
    const oldest = transactionAt(10, 1_000, 'settled');
    const middle = transactionAt(20, 2_000, 'settled');
    const newest = transactionAt(30, 3_000, 'settled');
    const dashboard = toDashboard(
      sourcesWith({ transactions: [middle, oldest, newest] }),
      { artBaseUrl: ART_BASE_URL },
    );

    expect(dashboard.latestTransactions.map((row) => row.id)).toEqual([
      newest.id,
      middle.id,
      oldest.id,
    ]);
  });

  it('lists no more transactions than the contract says it will', () => {
    const transactions = [10, 20, 30, 40, 50].map(
      (offset) => transactionAt(offset, 1_000, 'settled'),
    );
    const dashboard = toDashboard(
      sourcesWith({ transactions }),
      { artBaseUrl: ART_BASE_URL },
    );

    expect(dashboard.latestTransactions).toHaveLength(DASHBOARD_TRANSACTION_COUNT);
    // The control: it listed the newest ones, not simply the first three it
    // was handed.
    expect(dashboard.latestTransactions[0]?.bookedAt).toBe('2026-08-09T12:50:00.000Z');
  });

  it('lists every transaction of a company that has fewer than the screen draws', () => {
    const dashboard = toDashboard(
      sourcesWith({ transactions: [transactionAt(10, 1_000, 'settled')] }),
      { artBaseUrl: ART_BASE_URL },
    );

    expect(dashboard.latestTransactions).toHaveLength(1);
    expect(dashboard.furtherTransactionCount).toBe(0);
  });

  it('lists nothing for a card that has never been used', () => {
    const dashboard = toDashboard(sourcesWith({}), { artBaseUrl: ART_BASE_URL });

    expect(dashboard.latestTransactions).toEqual([]);
    expect(dashboard.furtherTransactionCount).toBe(0);
    expect(dashboard.spend.remaining.minorUnits).toBe(1_000_000);
  });

  /**
   * The count is of the rows behind the ones listed, not of the rows this
   * function was handed: the caller scopes its query to the spend window and
   * counts the whole collection separately.
   */
  it('counts the transactions beyond the ones it listed', () => {
    const transactions = [10, 20, 30, 40].map(
      (offset) => transactionAt(offset, 1_000, 'settled'),
    );
    const dashboard = toDashboard(
      sourcesWith({ transactions, transactionCount: 57 }),
      { artBaseUrl: ART_BASE_URL },
    );

    expect(dashboard.furtherTransactionCount).toBe(54);
  });

  /**
   * The count is of what was *listed*, not of the ceiling the contract
   * publishes. A company with two transactions in the current window and ten
   * altogether has eight behind the two the screen draws, and a subtraction
   * written against `DASHBOARD_TRANSACTION_COUNT` reports seven.
   */
  it('counts from the transactions it listed, not from the contract ceiling', () => {
    const transactions = [10, 20].map((offset) => transactionAt(offset, 1_000, 'settled'));
    const dashboard = toDashboard(
      sourcesWith({ transactions, transactionCount: 10 }),
      { artBaseUrl: ART_BASE_URL },
    );

    expect(dashboard.latestTransactions).toHaveLength(2);
    expect(dashboard.furtherTransactionCount).toBe(8);
  });

  /**
   * A total smaller than what was listed is a caller that counted and queried
   * inconsistently. Publishing the negative would break the contract's
   * `minimum: 0` for every consumer, so the payload stays valid and the fault
   * stays the caller's.
   */
  it('never publishes a negative further-transaction count', () => {
    const dashboard = toDashboard(
      sourcesWith({
        transactions: [transactionAt(10, 1_000, 'settled')],
        transactionCount: 0,
      }),
      { artBaseUrl: ART_BASE_URL },
    );

    expect(dashboard.furtherTransactionCount).toBe(0);
  });

  it('folds the card through the card mapper rather than passing the row through', () => {
    const dashboard = toDashboard(
      sourcesWith({ card: { ...CARD, lifecycleStatus: 'terminated' } }),
      { artBaseUrl: ART_BASE_URL },
    );

    expect(dashboard.card.state).toBe('closed');
    // Spec section 2.5: absent, never null. An unactivated card has no key.
    expect('activatedAt' in dashboard.card).toBe(false);
  });

  it('refuses a spend limit belonging to a different card', () => {
    const foreign = { ...SPEND_LIMIT, cardId: '99999999-9999-4999-8999-999999999999' };

    expect(() => toDashboard(
      sourcesWith({ spendLimit: foreign }),
      { artBaseUrl: ART_BASE_URL },
    )).toThrow(/spend limit/i);
    // The control: the same call with the card's own limit still assembles, so
    // the refusal is of this row rather than of everything.
    expect(() => toDashboard(sourcesWith({}), { artBaseUrl: ART_BASE_URL })).not.toThrow();
  });

  it('refuses a card belonging to a different company', () => {
    const foreign = { ...CARD, companyId: '99999999-9999-4999-8999-999999999999' };

    expect(() => toDashboard(
      // The limit still names this card, so the only fault is the company.
      sourcesWith({ card: foreign }),
      { artBaseUrl: ART_BASE_URL },
    )).toThrow(/company/i);
    expect(() => toDashboard(sourcesWith({}), { artBaseUrl: ART_BASE_URL })).not.toThrow();
  });
});

describe('toDashboard against the seeded demo data', () => {
  /**
   * The headline case: the two numbers `assets/mobile-view.png` renders, as
   * literals rather than as anything derived from the seed.
   *
   * `packages/db`'s seed is arranged so the three plausible wrong answers are
   * each distinct from this one — `447700` without the settlement filter,
   * `300000` without the window filter, `510000` taking the magnitude of the
   * refund. That is what makes `540000` a reading rather than a coincidence.
   */
  it('reads 540000 of 1000000 remaining, with 54 further transactions', () => {
    const dashboard = toDashboard(seededSources(), { artBaseUrl: ART_BASE_URL });

    expect(dashboard.spend).toStrictEqual({
      remaining: { minorUnits: 540_000, currency: 'SEK' },
      limit: { minorUnits: 1_000_000, currency: 'SEK' },
    });
    expect(dashboard.latestTransactions).toHaveLength(3);
    expect(dashboard.furtherTransactionCount).toBe(54);
  });

  /**
   * The same figures against the seed's own declared constants rather than
   * against the screenshot's literals. The two fail for different reasons: the
   * case above catches a seed edited away from the screen, this one catches a
   * seed whose rows stopped matching the figures it advertises.
   */
  it('agrees with the figures the seed declares', () => {
    const dashboard = toDashboard(seededSources(), { artBaseUrl: ART_BASE_URL });

    expect(dashboard.spend.remaining.minorUnits)
      .toBe(SEED_FIGURES.remainingSpendMinorUnits);
    expect(dashboard.spend.limit.minorUnits).toBe(SEED_FIGURES.spendCapMinorUnits);
    expect(dashboard.spend.limit.currency).toBe(SEED_FIGURES.currencyCode);
    expect(dashboard.furtherTransactionCount)
      .toBe(SEED_FIGURES.furtherTransactionCount);
    expect(dashboard.latestTransactions)
      .toHaveLength(SEED_FIGURES.dashboardTransactionCount);
  });

  /**
   * The seed's newest row of all is `authorised`, not `settled`. It is one of
   * the three the screen lists and it is not part of the spend the meter
   * subtracts — the single row that separates "lists the newest" from
   * "lists the newest that counted".
   */
  it('lists the newest transaction even though it is not counted against the cap', () => {
    const sources = seededSources();
    const dashboard = toDashboard(sources, { artBaseUrl: ART_BASE_URL });
    const newest = dashboard.latestTransactions[0];

    expect(newest?.settlementState).toBe('pending');
    expect(newest?.id).toBe(sources.transactions[0]?.id);
  });

  /**
   * The window filter, grounded in the demo rather than in a fixture. The seed
   * books six settled transactions before the window opened; a mapper that
   * counted them would answer `300000`.
   */
  it('leaves the seeded transactions booked before the window out of the spend', () => {
    const { transactions, spendLimit } = seededSources();
    const beforeWindow = transactions.filter(
      (row) => row.bookedAt < spendLimit.periodStartedAt,
    );

    expect(beforeWindow.length).toBeGreaterThan(0);
    expect(settledSpendMinorUnits(transactions, spendLimit.periodStartedAt))
      .toBe(SEED_FIGURES.settledInPeriodMinorUnits);
  });

  it('publishes the seeded company and card the mappers fold them into', () => {
    const dashboard = toDashboard(seededSources(), { artBaseUrl: ART_BASE_URL });

    expect(dashboard.company).toStrictEqual({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Company AB',
    });
    expect(dashboard.card.lastFour).toBe('4321');
    expect(dashboard.card.state).toBe('inactive');
  });
});
