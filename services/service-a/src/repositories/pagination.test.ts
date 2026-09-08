/**
 * The page-request guard, which is the last thing between a caller and a
 * `LIMIT` clause.
 *
 * No database here on purpose: nothing in this module touches one, and the
 * suites beside it that do are slower by a Postgres. What this file owns is
 * the two claims that are invisible in a query — that the ceiling this layer
 * enforces is the ceiling the **contract publishes**, and that a count query
 * returning nothing is reported rather than rendered as zero.
 */
import { PAGE_LIMIT_MAX, PAGE_LIMIT_MIN } from '@marcos-corp/contracts-service-a';
import { describe, expect, it } from 'vitest';

import {
  assertPageRequest,
  PageRequestError,
  readTotal,
  type PageRequest,
} from './pagination';

/** A page every case can start from, so each one varies exactly one field. */
const USABLE: PageRequest = { limit: 20, offset: 0 };

/** Far past any page anyone would ask for, and deliberately still legal. */
const DEEP_OFFSET = 5_000_000;

function rejectionOf(page: PageRequest): PageRequestError {
  try {
    assertPageRequest(page);
  } catch (error) {
    if (error instanceof PageRequestError) {
      return error;
    }
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(page)} to be refused, and it was accepted`);
}

describe('assertPageRequest', () => {
  it('returns the request it checked, so a caller cannot use the unchecked one', () => {
    expect(assertPageRequest(USABLE)).toEqual(USABLE);
  });

  it('accepts both ends of the range the contract publishes', () => {
    expect(assertPageRequest({ limit: PAGE_LIMIT_MIN, offset: 0 }))
      .toEqual({ limit: PAGE_LIMIT_MIN, offset: 0 });
    expect(assertPageRequest({ limit: PAGE_LIMIT_MAX, offset: 0 }))
      .toEqual({ limit: PAGE_LIMIT_MAX, offset: 0 });
  });

  it('refuses one row past the published ceiling, so the bound is that constant', () => {
    // Paired with the accepting case above, this pins the boundary to
    // `PAGE_LIMIT_MAX` itself rather than to a number that happens to equal it
    // today: raising the contract's ceiling moves both cases together, and a
    // second hand-written copy of the figure here would move neither.
    const rejection = rejectionOf({ limit: PAGE_LIMIT_MAX + 1, offset: 0 });

    expect(rejection.problems).toEqual([
      `limit must be at most ${PAGE_LIMIT_MAX}, the contract's published ceiling`,
    ]);
  });

  it('refuses a page of nothing', () => {
    expect(rejectionOf({ limit: PAGE_LIMIT_MIN - 1, offset: 0 }).problems)
      .toEqual([`limit must be at least ${PAGE_LIMIT_MIN}`]);
  });

  it('refuses a fractional limit, which SQL would silently accept', () => {
    expect(rejectionOf({ limit: 1.5, offset: 0 }).problems)
      .toEqual(['limit must be a whole number of rows']);
  });

  it('refuses a negative offset', () => {
    expect(rejectionOf({ limit: 20, offset: -1 }).problems)
      .toEqual(['offset must be at least 0']);
  });

  it('accepts an offset far past the end, because the contract states no ceiling', () => {
    // The inverting half of the two refusals above. A guard that capped deep
    // paging would reject a request `PageInfo.offset` says is legal — the
    // provider would then be refusing inside its own published range, which is
    // a documentation bug rather than a safety measure. Without this case,
    // adding such a cap breaks nothing here.
    expect(assertPageRequest({ limit: 20, offset: DEEP_OFFSET }))
      .toEqual({ limit: 20, offset: DEEP_OFFSET });
  });

  it('refuses a field nobody declared, naming it', () => {
    const rejection = rejectionOf(
      { ...USABLE, cursor: 'abc' } as unknown as PageRequest,
    );

    expect(rejection.problems).toHaveLength(1);
    expect(rejection.problems[0]).toContain('cursor');
  });

  it('reports every unusable field in one throw, not just the first', () => {
    const rejection = rejectionOf({ limit: 0, offset: -3 });

    expect(rejection.problems).toEqual([
      `limit must be at least ${PAGE_LIMIT_MIN}`,
      'offset must be at least 0',
    ]);
  });

  it('throws a PageRequestError a route can branch on, with the fields in its message', () => {
    const rejection = rejectionOf({ limit: 0, offset: 0 });

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.name).toBe('PageRequestError');
    expect(rejection.message).toContain('page request is unusable');
    expect(rejection.message).toContain('limit must be at least');
  });
});

describe('readTotal', () => {
  it('reads the count out of the single row an aggregate returns', () => {
    expect(readTotal([{ total: 57 }])).toBe(57);
  });

  it('reads a genuine zero as zero', () => {
    expect(readTotal([{ total: 0 }])).toBe(0);
  });

  it('throws on no row rather than reporting zero', () => {
    // The whole reason this helper exists instead of `rows[0]?.total ?? 0`.
    // A default would turn "the query did something this code does not
    // understand" into "there are no transactions", which the dashboard would
    // render as `0 more items` — a plausible figure nobody could question.
    expect(() => readTotal([])).toThrow(/ungrouped aggregate cannot do/);
  });
});
