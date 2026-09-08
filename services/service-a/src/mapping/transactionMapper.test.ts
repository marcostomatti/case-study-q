/**
 * Runtime suite for `transactionMapper.ts`.
 *
 * The module folds two enums and assembles one object, and each is a separate
 * claim:
 *
 * - **Every database settlement state folds onto the contract's**, all four,
 *   and an unrecognised value onto `unknown` (spec section 2.5). The fold is
 *   closed in both directions: no database state is unhandled, and no
 *   published state other than `unknown` is unreachable.
 * - **A raw ISO-18245 MCC folds onto a coarse category**, an unclassified code
 *   folds onto `unknown`, and the range table it folds through is ascending
 *   and non-overlapping — a property no behavioural case can see, because an
 *   overlapping table still answers.
 * - **Money is assembled from two columns into one object**, sign intact, and
 *   the columns the contract does not publish stay unpublished.
 *
 * Every fold-onto-`unknown` case sits beside the exhaustive cases for the same
 * enum, for the reason the neighbouring suites give: on its own it passes
 * against a mapper that answers `unknown` for everything.
 */
import type { MerchantCategoryRange } from './transactionMapper';
import type {
  MerchantCategory,
  TransactionSettlementState,
} from '@marcos-corp/contracts-service-a';
import type { Transaction as TransactionRow } from '@marcos-corp/db';

import {
  MERCHANT_CATEGORIES,
  TRANSACTION_SETTLEMENT_STATES,
} from '@marcos-corp/contracts-service-a';
import { transactionSettlementState } from '@marcos-corp/db';
import { buildSeedRows } from '@marcos-corp/db/seed';
import { describe, expect, it } from 'vitest';

import {
  MERCHANT_CATEGORY_RANGES,
  toContractMerchantCategory,
  toContractSettlementState,
  toContractTransaction,
} from './transactionMapper';

/** The newest settled row `packages/db`'s seed inserts, as a query returns it. */
const SEEDED_TRANSACTION: TransactionRow = {
  id: '55555555-5555-4555-8555-000000000003',
  cardId: '22222222-2222-4222-8222-222222222222',
  companyId: '11111111-1111-4111-8111-111111111111',
  bookedAt: new Date('2026-09-07T18:12:00.000Z'),
  amountMinorUnits: 4_500,
  currencyCode: 'SEK',
  merchantName: 'Pressbyran Odenplan',
  merchantCategoryCode: '5499',
  settlementState: 'settled',
};

/** The same row with one column changed, so a case says what it varies. */
function transactionWith(overrides: Partial<TransactionRow>): TransactionRow {
  return { ...SEEDED_TRANSACTION, ...overrides };
}

/**
 * The ranges that break the table's two invariants: a run that ends before it
 * starts, or one that begins at or before the previous run's end.
 *
 * Written once and applied to the real table and to a deliberately broken one,
 * because a checker that reports nothing is indistinguishable from a table
 * that is correct.
 */
function brokenRanges(
  ranges: readonly MerchantCategoryRange[],
): readonly MerchantCategoryRange[] {
  return ranges.filter((range, index) => {
    const previous = ranges[index - 1];

    return range.from > range.to
      || (previous !== undefined && range.from <= previous.to);
  });
}

describe('toContractSettlementState', () => {
  /**
   * Every member of the database enum, named individually so a failure says
   * which state stopped folding.
   *
   * `authorised` and `disputed` are the pair that proves this is a fold rather
   * than a rename: two clearing-cycle states reaching one published state is
   * how the contract stays coarser than the schema.
   */
  const KNOWN_STATES: ReadonlyArray<readonly [string, TransactionSettlementState]> = [
    ['authorised', 'pending'],
    ['settled', 'completed'],
    ['reversed', 'reversed'],
    ['disputed', 'pending'],
  ];

  it.each(KNOWN_STATES)('folds the database state %s onto %s', (stored, published) => {
    expect(toContractSettlementState(stored)).toBe(published);
  });

  it('folds a state this build has never heard of onto unknown', () => {
    expect(toContractSettlementState('chargeback_reversed')).toBe('unknown');
  });

  it('folds an empty state onto unknown rather than throwing', () => {
    expect(toContractSettlementState('')).toBe('unknown');
  });

  /**
   * Closure, database side: the runtime half of the totality `check-types`
   * already gets from the record's type, and the half that survives a cast
   * somebody adds later.
   */
  it('publishes a real state for every member of the database enum', () => {
    const unhandled = transactionSettlementState.enumValues.filter(
      (value) => toContractSettlementState(value) === 'unknown',
    );

    expect(unhandled).toEqual([]);
    // The control: an empty list has to mean something.
    expect(transactionSettlementState.enumValues.length).toBeGreaterThan(0);
  });

  /**
   * Closure, contract side. A published member no database state folds onto is
   * a branch every consumer writes and nothing ever takes.
   */
  it('reaches every published settlement state except unknown', () => {
    const reached = new Set(
      transactionSettlementState.enumValues.map(toContractSettlementState),
    );
    const unreachable = TRANSACTION_SETTLEMENT_STATES.filter(
      (state) => state !== 'unknown' && !reached.has(state),
    );

    expect(unreachable).toEqual([]);
  });
});

describe('toContractMerchantCategory', () => {
  /**
   * One code per published category, chosen from the codes this provider
   * actually acquires. `5734` is deliberately among them: it is a software
   * code sitting inside the electronics run, and it is the case that fails
   * first if the table is ever re-sorted into an overlapping one.
   */
  const KNOWN_CODES: ReadonlyArray<readonly [string, MerchantCategory]> = [
    ['4111', 'travel'],
    ['4112', 'travel'],
    ['7011', 'travel'],
    ['4814', 'telecom'],
    ['5499', 'groceries'],
    ['5541', 'fuel'],
    ['5552', 'fuel'],
    ['5814', 'dining'],
    ['5200', 'retail'],
    ['5732', 'retail'],
    ['5734', 'software'],
    ['7372', 'software'],
  ];

  it.each(KNOWN_CODES)('classifies the MCC %s as %s', (code, category) => {
    expect(toContractMerchantCategory(code)).toBe(category);
  });

  /**
   * An MCC no range claims. `9999` is unassigned in ISO-18245, so this is the
   * shape of the change spec section 2.5 exists for: a code the acquirer
   * starts sending that this build predates.
   */
  it('folds an unclassified MCC onto unknown', () => {
    expect(toContractMerchantCategory('9999')).toBe('unknown');
  });

  /**
   * A value that is not an MCC at all. The column is `char(4)`, so anything
   * here has already escaped the schema and guessing at it would publish a
   * category nobody can account for.
   */
  it.each([
    ['empty', ''],
    ['short', '581'],
    ['long', '58140'],
    ['non-numeric', '58Z4'],
    // The one the four-digit guard actually owns: `parseInt` would read this
    // as `5814` and publish `dining` for a value that is not an MCC.
    ['trailing-junk', '5814x'],
  ])(
    'folds a %s category code onto unknown',
    (_label, code) => {
      expect(toContractMerchantCategory(code)).toBe('unknown');
      // The control: a well-formed code beside it still classifies, so
      // `unknown` is a refusal of this value rather than of everything.
      expect(toContractMerchantCategory('5814')).toBe('dining');
    },
  );

  /**
   * Closure, contract side. A published category no range produces is one
   * every consumer draws an icon for and never renders.
   */
  it('reaches every published merchant category except unknown', () => {
    const declared = new Set(MERCHANT_CATEGORY_RANGES.map((range) => range.category));
    const unreachable = MERCHANT_CATEGORIES.filter(
      (category) => category !== 'unknown' && !declared.has(category),
    );

    expect(unreachable).toEqual([]);
  });

  /**
   * The table's structural invariant, which no behavioural case can see: an
   * overlapping table answers with whichever entry `find` reaches first and
   * reads as working.
   */
  it('declares its ranges ascending and non-overlapping', () => {
    expect(brokenRanges(MERCHANT_CATEGORY_RANGES)).toEqual([]);
    expect(MERCHANT_CATEGORY_RANGES.length).toBeGreaterThan(0);
  });

  /**
   * The control the invariant needs. Without it, `brokenRanges` returning
   * nothing is indistinguishable from a check that reports nothing ever.
   */
  it('reports a range table that overlaps or runs backwards', () => {
    const overlapping: MerchantCategoryRange[] = [
      { from: 5000, to: 5100, category: 'retail' },
      { from: 5050, to: 5200, category: 'dining' },
    ];
    const backwards: MerchantCategoryRange[] = [
      { from: 5100, to: 5000, category: 'retail' },
    ];

    expect(brokenRanges(overlapping)).toHaveLength(1);
    expect(brokenRanges(backwards)).toHaveLength(1);
  });

  /**
   * Grounding: every code the demo actually inserts classifies. This is what
   * stops a later edit to the ranges, or a new merchant added to the seed,
   * from quietly rendering the mobile view's transaction list as a column of
   * `unknown` categories.
   */
  it('classifies every merchant category code the seed inserts', () => {
    const { transactions } = buildSeedRows({ now: new Date('2026-09-08T12:00:00.000Z') });
    const unclassified = transactions
      .map((row) => row.merchantCategoryCode)
      .filter((code) => toContractMerchantCategory(code) === 'unknown');

    expect([...new Set(unclassified)]).toEqual([]);
    // The control: the seed inserts rows at all, so an empty list is a
    // statement about the codes rather than about an empty seed.
    expect(transactions.length).toBeGreaterThan(0);
  });
});

describe('toContractTransaction', () => {
  /**
   * The whole payload at once. A per-field check passes just as happily when a
   * column starts leaking into the response, and `cardId`, `companyId` and the
   * two flat money columns are exactly what a derived schema would publish.
   */
  it('publishes the contract shape and nothing else', () => {
    expect(toContractTransaction(SEEDED_TRANSACTION)).toStrictEqual({
      id: '55555555-5555-4555-8555-000000000003',
      bookedAt: '2026-09-07T18:12:00.000Z',
      merchantName: 'Pressbyran Odenplan',
      merchantCategory: 'groceries',
      amount: { minorUnits: 4_500, currency: 'SEK' },
      settlementState: 'completed',
    });
  });

  /**
   * The signed-minor-units convention, which is what lets the dashboard mapper
   * compute `cap - SUM(settled)` with no special case for a return. The seed
   * carries one negative row for this reason.
   */
  it('keeps a refund negative rather than taking its magnitude', () => {
    const refund = toContractTransaction(transactionWith({
      merchantName: 'Clas Ohlson Retur',
      merchantCategoryCode: '5200',
      amountMinorUnits: -15_000,
    }));

    expect(refund.amount).toStrictEqual({ minorUnits: -15_000, currency: 'SEK' });
  });

  it('folds an unrecognised settlement state on a whole row too', () => {
    const row = toContractTransaction(transactionWith({
      settlementState: 'chargeback_reversed' as TransactionRow['settlementState'],
    }));

    expect(row.settlementState).toBe('unknown');
    // The control: the rest of the row still maps, so `unknown` is a folded
    // value rather than a mapper that gave up.
    expect(row.merchantName).toBe('Pressbyran Odenplan');
  });

  it('folds an unrecognised category code on a whole row too', () => {
    const row = toContractTransaction(transactionWith({ merchantCategoryCode: '9999' }));

    expect(row.merchantCategory).toBe('unknown');
    expect(row.settlementState).toBe('completed');
  });

  /**
   * Asserted by name as well as by the whole-shape case above, because these
   * are the specific fields a schema derived from the table would have
   * published.
   */
  it.each([
    'cardId',
    'companyId',
    'amountMinorUnits',
    'currencyCode',
    'merchantCategoryCode',
  ])('does not publish the database field %s', (field) => {
    expect(field in toContractTransaction(SEEDED_TRANSACTION)).toBe(false);
  });
});
