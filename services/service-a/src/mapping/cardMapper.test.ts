/**
 * Runtime suite for `cardMapper.ts`.
 *
 * The module makes four claims that can each be true or false independently,
 * and the file is organised around them:
 *
 * - **Every database card state folds onto the contract's**, all five of them,
 *   and an unrecognised value folds onto `unknown` rather than throwing or
 *   escaping (spec section 2.5).
 * - **The fold is closed in both directions.** No database state is left
 *   unhandled, and no contract state other than `unknown` is unreachable — a
 *   member the provider can never emit is one every consumer writes dead code
 *   for.
 * - **A null column becomes an absent field, never a `null` one.** The key is
 *   not present, which is a stronger claim than "serialises to nothing" and
 *   needs `toStrictEqual` and an `in` check to state.
 * - **The stored asset key becomes an absolute URL**, and a base that cannot
 *   produce one is refused rather than published.
 *
 * Two shapes recur, for the reason the neighbouring `usageLogger` suite gives.
 * A case asserting a value was folded onto `unknown` passes just as well
 * against a mapper that answers `unknown` for everything, so the unrecognised
 * legs sit beside the exhaustive ones that must not; and a case asserting
 * something was refused is paired with a control that must still succeed.
 */
import type { CardState } from '@marcos-corp/contracts-service-a';
import type { Card as CardRow } from '@marcos-corp/db';

import { CARD_STATES } from '@marcos-corp/contracts-service-a';
import { cardLifecycleStatus } from '@marcos-corp/db';
import { describe, expect, it } from 'vitest';

import { resolveCardArtUrl, toContractCard, toContractCardState } from './cardMapper';

/** Where `server.ts` will say card artwork is served from. */
const ART_BASE_URL = 'https://cdn.example.com/assets';

/** The instant the seeded card would be activated at, if it were. */
const ACTIVATED_AT = new Date('2026-08-14T09:30:00.000Z');

/**
 * The seeded card, in the state `packages/db` leaves it: issued, not yet
 * activated, so `activatedAt` is the column that has to disappear rather than
 * become a `null`.
 */
const SEEDED_CARD: CardRow = {
  id: '22222222-2222-4222-8222-222222222222',
  companyId: '11111111-1111-4111-8111-111111111111',
  panLastFour: '4321',
  lifecycleStatus: 'issued',
  activatedAt: null,
  artAssetKey: 'card-art/business-black-v2',
};

/** The same card with one column changed, so a case says what it varies. */
function cardWith(overrides: Partial<CardRow>): CardRow {
  return { ...SEEDED_CARD, ...overrides };
}

describe('toContractCardState', () => {
  /**
   * Every member of the database enum, named individually so a failure says
   * which state stopped folding rather than that "the table changed".
   *
   * `ordered` and `issued` are the pair that proves the fold is a fold: two
   * database states reaching one contract state is what makes the contract
   * coarser than the schema, which is the entire argument for spec section
   * 2.1 that a rename alone would not make.
   */
  const KNOWN_STATES: ReadonlyArray<readonly [string, CardState]> = [
    ['ordered', 'inactive'],
    ['issued', 'inactive'],
    ['active', 'active'],
    ['frozen', 'frozen'],
    ['terminated', 'closed'],
  ];

  it.each(KNOWN_STATES)('folds the database state %s onto %s', (stored, published) => {
    expect(toContractCardState(stored)).toBe(published);
  });

  /**
   * The unrecognised leg, and the reason the exhaustive cases above sit beside
   * it: on its own this passes against a mapper that answers `unknown` for
   * everything.
   */
  it('folds a state this build has never heard of onto unknown', () => {
    expect(toContractCardState('suspended')).toBe('unknown');
  });

  it('folds an empty state onto unknown rather than throwing', () => {
    expect(toContractCardState('')).toBe('unknown');
  });

  /**
   * Closure, database side. The table in the module is typed as total over
   * `CardLifecycleStatus`, so this is the runtime half of a claim
   * `check-types` already makes — and the half that survives a cast somebody
   * adds later.
   */
  it('publishes a real state for every member of the database enum', () => {
    const unhandled = cardLifecycleStatus.enumValues.filter(
      (value) => toContractCardState(value) === 'unknown',
    );

    expect(unhandled).toEqual([]);
    // The control: the list being empty has to mean something, so assert the
    // enum it was filtered from is not itself empty.
    expect(cardLifecycleStatus.enumValues.length).toBeGreaterThan(0);
  });

  /**
   * Closure, contract side. A published member no database state folds onto is
   * a member every consumer writes an unreachable branch for, and nothing else
   * in the four-gate order would ever say so.
   */
  it('reaches every published card state except unknown', () => {
    const reached = new Set(cardLifecycleStatus.enumValues.map(toContractCardState));
    const unreachable = CARD_STATES.filter(
      (state) => state !== 'unknown' && !reached.has(state),
    );

    expect(unreachable).toEqual([]);
  });
});

describe('resolveCardArtUrl', () => {
  it('joins a base with no trailing slash', () => {
    expect(resolveCardArtUrl('card-art/business-black-v2', 'https://cdn.example.com/assets'))
      .toBe('https://cdn.example.com/assets/card-art/business-black-v2.png');
  });

  /**
   * The `new URL(key, base)` failure this join exists to avoid: the two-
   * argument form drops `assets` when the base has no trailing slash, so both
   * spellings of the base have to reach the same URL.
   */
  it('joins a base with a trailing slash to the same URL', () => {
    expect(resolveCardArtUrl('card-art/business-black-v2', 'https://cdn.example.com/assets/'))
      .toBe('https://cdn.example.com/assets/card-art/business-black-v2.png');
  });

  it('does not double the separator when the key is stored with one', () => {
    expect(resolveCardArtUrl('/card-art/business-black-v2', ART_BASE_URL))
      .toBe('https://cdn.example.com/assets/card-art/business-black-v2.png');
  });

  /**
   * Refusing a base that cannot produce an absolute URL, with the control the
   * refusal needs: a check that rejected everything would pass the first
   * expectation and fail the second.
   */
  it.each([
    ['an empty', ''],
    ['a relative', '/assets'],
    ['a host-only', 'cdn.example.com'],
    ['a non-http-scheme', 'ftp://cdn.example.com'],
  ])('refuses %s art base URL', (_label, base) => {
    expect(() => resolveCardArtUrl('card-art/x', base)).toThrow(/absolute http/);
    expect(() => resolveCardArtUrl('card-art/x', ART_BASE_URL)).not.toThrow();
  });

  it('names the rejected base so a misconfiguration is readable', () => {
    expect(() => resolveCardArtUrl('card-art/x', 'cdn.example.com'))
      .toThrow(/'cdn\.example\.com'/);
  });
});

describe('toContractCard', () => {
  /**
   * The whole payload, asserted at once. A per-field check passes just as
   * happily when a column starts leaking into the response, and a leaked
   * `companyId` or `artAssetKey` is exactly the failure spec section 2.1 is
   * about.
   */
  it('publishes the contract shape and nothing else', () => {
    expect(toContractCard(SEEDED_CARD, { artBaseUrl: ART_BASE_URL })).toStrictEqual({
      id: '22222222-2222-4222-8222-222222222222',
      lastFour: '4321',
      state: 'inactive',
      artUrl: 'https://cdn.example.com/assets/card-art/business-black-v2.png',
    });
  });

  /**
   * Spec section 2.5's absent-not-null convention, stated as an absence rather
   * than inferred from the payload above. `toStrictEqual` already distinguishes
   * a missing key from an `undefined` one; the `in` check says so in a way a
   * reader does not have to know that about vitest to trust.
   */
  it('omits activatedAt entirely for a card nobody has activated', () => {
    const card = toContractCard(SEEDED_CARD, { artBaseUrl: ART_BASE_URL });

    expect('activatedAt' in card).toBe(false);
    expect(JSON.stringify(card)).not.toContain('activatedAt');
  });

  /**
   * The inverting leg the absence case needs. Without it, a mapper that never
   * emits `activatedAt` at all passes the case above.
   */
  it('publishes activatedAt as an instant for a card that has been activated', () => {
    const card = toContractCard(
      cardWith({ lifecycleStatus: 'active', activatedAt: ACTIVATED_AT }),
      { artBaseUrl: ART_BASE_URL },
    );

    expect(card.activatedAt).toBe('2026-08-14T09:30:00.000Z');
    expect(card.state).toBe('active');
  });

  it('folds an unrecognised lifecycle status on a whole row too', () => {
    const card = toContractCard(
      cardWith({ lifecycleStatus: 'suspended' as CardRow['lifecycleStatus'] }),
      { artBaseUrl: ART_BASE_URL },
    );

    expect(card.state).toBe('unknown');
    // The control: the rest of the row still maps, so `unknown` is a folded
    // value rather than a mapper that gave up on the card.
    expect(card.lastFour).toBe('4321');
  });

  /**
   * The database's identifiers and storage keys are not the contract's
   * business. Asserted by name as well as by the whole-shape case above,
   * because these three are the specific fields a derived schema would have
   * published.
   */
  it.each(['companyId', 'artAssetKey', 'lifecycleStatus', 'panLastFour'])(
    'does not publish the database field %s',
    (field) => {
      const card = toContractCard(SEEDED_CARD, { artBaseUrl: ART_BASE_URL });

      expect(field in card).toBe(false);
    },
  );
});
