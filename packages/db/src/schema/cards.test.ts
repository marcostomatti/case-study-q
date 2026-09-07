import { describe, expect, it } from 'vitest';

import { columnFacts, foreignKeyFacts, sqlTableName } from '../testing/tableFacts';

import { cardLifecycleStatus, cards } from './cards';

/**
 * The contract's spelling of the card state, written out here rather than
 * imported. `packages/contracts-service-a` does not exist yet, and once it
 * does this package must not import it any more than the reverse — the point
 * of the case below is that the two vocabularies are chosen independently.
 * A shared constant would make them one decision again.
 */
const CONTRACT_CARD_STATE_FIELDS = ['state', 'card_state', 'status'] as const;

/**
 * What this file pins that `cards.test-d.ts` cannot.
 *
 * `Card['lifecycleStatus']` is the same union whatever the column is called,
 * so no type assertion can state the one thing this table exists to
 * demonstrate: that the database's name for the card state is not the
 * contract's name for it (spec §2.1). That divergence is what gives
 * `service-a`'s mapper something real to translate, and what makes a column
 * rename a migration instead of a breaking change. It is also precisely the
 * kind of thing a later tidy-up removes in good faith, which is why it is
 * asserted rather than only commented.
 */
describe('cards table', () => {
  it('reaches SQL as `cards`', () => {
    expect(sqlTableName(cards)).toBe('cards');
  });

  it('maps each TypeScript property onto a deliberately un-contract-like column', () => {
    expect(columnFacts(cards)).toEqual({
      id: {
        sqlName: 'id',
        sqlType: 'uuid',
        notNull: true,
        hasDefault: true,
        isPrimaryKey: true,
        isUnique: false,
      },
      companyId: {
        sqlName: 'company_id',
        sqlType: 'uuid',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      panLastFour: {
        sqlName: 'pan_last_four',
        sqlType: 'char(4)',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      lifecycleStatus: {
        sqlName: 'lifecycle_status',
        sqlType: 'card_lifecycle_status',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      activatedAt: {
        sqlName: 'activated_at',
        sqlType: 'timestamp with time zone',
        notNull: false,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      artAssetKey: {
        sqlName: 'art_asset_key',
        sqlType: 'text',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
    });
  });

  it('names the card state column differently from anything the contract could call it', () => {
    const sqlNames = Object.values(columnFacts(cards)).map((facts) => facts.sqlName);

    expect(columnFacts(cards).lifecycleStatus?.sqlName).toBe('lifecycle_status');
    CONTRACT_CARD_STATE_FIELDS.forEach((candidate) => {
      expect(sqlNames).not.toContain(candidate);
    });
  });

  it('declares the card states the provider knows about', () => {
    expect(cardLifecycleStatus.enumName).toBe('card_lifecycle_status');
    expect(cardLifecycleStatus.enumValues).toEqual([
      'ordered',
      'issued',
      'active',
      'frozen',
      'terminated',
    ]);
  });

  it('gives the database enum no `unknown` member', () => {
    // Spec §2.5 requires an explicit unknown member on every *contract* enum,
    // so a consumer pinned to an older version survives a value it has never
    // seen. A database enum has no such reader — every value in it is one this
    // schema declared — so mirroring the convention here would publish a state
    // no card is ever in. The mapper folds unrecognised values onto the
    // contract's `unknown`, which is what makes adding a member above a
    // non-breaking change rather than a coordinated deploy.
    expect(cardLifecycleStatus.enumValues).not.toContain('unknown');
  });

  it('leaves the activation timestamp nullable and ungenerated', () => {
    const activatedAt = columnFacts(cards).activatedAt;

    // The one column whose nullability the contract must not inherit: spec
    // §2.5 says `null` is never emitted and absent means not applicable, so
    // the mapper omits the field for an unactivated card rather than passing
    // the `null` through. `hasDefault` is asserted alongside because a
    // `defaultNow()` added here would silently activate every card on insert.
    expect(activatedAt?.notNull).toBe(false);
    expect(activatedAt?.hasDefault).toBe(false);
  });

  it('points company_id at companies.id and refuses to orphan a card', () => {
    expect(foreignKeyFacts(cards)).toEqual([
      {
        columns: ['company_id'],
        referencedTable: 'companies',
        referencedColumns: ['id'],
        onDelete: 'restrict',
      },
    ]);
  });
});
