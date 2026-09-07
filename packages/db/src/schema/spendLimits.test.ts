import { describe, expect, it } from 'vitest';

import {
  columnFacts,
  foreignKeyFacts,
  primaryKeyFacts,
  sqlTableName,
} from '../testing/tableFacts';

import { spendLimitResetPeriod, spendLimits } from './spendLimits';

/**
 * The contract's spelling of the remaining-spend figure, written out here
 * rather than imported. `packages/contracts-service-a` does not exist yet, and
 * once it does this package must not import it any more than the reverse — the
 * point of the case below is that no column carries these names because the
 * figure is computed, not stored.
 */
const CONTRACT_REMAINING_SPEND_FIELDS = ['remaining', 'remaining_spend', 'spent'] as const;

/**
 * What this file pins that `spendLimits.test-d.ts` cannot.
 *
 * An inferred row type erases every SQL name, the composite key, the foreign
 * key and its `ON DELETE` action. All four are decisions this table makes on
 * purpose, and the last one differs from every other foreign key in the schema,
 * so it is exactly the kind of thing a later tidy-up "corrects" in good faith.
 */
describe('spend_limits table', () => {
  it('reaches SQL as `spend_limits`', () => {
    expect(sqlTableName(spendLimits)).toBe('spend_limits');
  });

  it('maps each TypeScript property onto a deliberately un-contract-like column', () => {
    // `isPrimaryKey` is false for every column, including the three that form
    // the key. `.primaryKey()` on a column builder sets that flag; a table-level
    // `primaryKey({ columns })` does not touch any column. The key is asserted
    // through `primaryKeyFacts` below — reading only this record would describe
    // the table as having no primary key at all.
    expect(columnFacts(spendLimits)).toEqual({
      cardId: {
        sqlName: 'card_id',
        sqlType: 'uuid',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      capMinorUnits: {
        sqlName: 'cap_minor_units',
        sqlType: 'integer',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      resetPeriod: {
        sqlName: 'reset_period',
        sqlType: 'spend_limit_reset_period',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      periodStartedAt: {
        sqlName: 'period_started_at',
        sqlType: 'timestamp with time zone',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
    });
  });

  it('stores no remaining-spend column, because the figure is computed', () => {
    // The strongest single argument in this schema for spec §2.1's
    // hand-authored contract: the field the mobile view renders — the `5 400` of
    // `5 400/10 000 kr` — has no column to derive itself from. It is the cap
    // minus the settled transactions in the window, assembled by `service-a`'s
    // dashboard mapper. A stored copy would be a second source of truth that
    // goes stale the moment a transaction settles.
    const sqlNames = Object.values(columnFacts(spendLimits)).map((facts) => facts.sqlName);

    CONTRACT_REMAINING_SPEND_FIELDS.forEach((candidate) => {
      expect(sqlNames).not.toContain(candidate);
    });
  });

  it('carries no currency column, taking the code from the owning company', () => {
    // Money in this repo is integer minor units plus an explicit ISO-4217 code.
    // The code for a limit is the company's `default_currency_code`, reached
    // through `cards.company_id`; a copy here would let a card's limit be
    // denominated in a currency its own transactions are not.
    const sqlNames = Object.values(columnFacts(spendLimits)).map((facts) => facts.sqlName);

    expect(sqlNames).not.toContain('currency_code');
    expect(sqlNames).toContain('cap_minor_units');
  });

  it('keys on card, period kind and window start, in that order', () => {
    // Order is asserted, not just the column set: a composite key serves only
    // the prefixes of its own ordering, and `card_id` leading is what makes the
    // dashboard's limit lookup an index read.
    expect(primaryKeyFacts(spendLimits)).toEqual([
      {
        name: 'spend_limits_card_id_reset_period_period_started_at_pk',
        columns: ['card_id', 'reset_period', 'period_started_at'],
      },
    ]);
  });

  it('cascades from cards, unlike every other foreign key in this schema', () => {
    // A spend limit is configuration scoped to a card and has no meaning
    // without it. `transactions` and `cards` both use RESTRICT because a
    // financial record must not disappear with its parent. The split is
    // deliberate; asserting it is what stops it being unified for consistency.
    expect(foreignKeyFacts(spendLimits)).toEqual([
      {
        columns: ['card_id'],
        referencedTable: 'cards',
        referencedColumns: ['id'],
        onDelete: 'cascade',
      },
    ]);
  });

  it('declares the reset periods the provider knows about', () => {
    expect(spendLimitResetPeriod.enumName).toBe('spend_limit_reset_period');
    expect(spendLimitResetPeriod.enumValues).toEqual(['monthly', 'quarterly', 'annual']);
  });

  it('gives the database enum no `unknown` member', () => {
    // Spec §2.5's unknown member protects a consumer reading a value its pinned
    // contract version predates. A database enum has no such reader, so
    // mirroring the convention would publish a period no limit is ever on.
    expect(spendLimitResetPeriod.enumValues).not.toContain('unknown');
  });
});
