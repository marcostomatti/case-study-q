import { describe, expect, it } from 'vitest';

import {
  columnFacts,
  foreignKeyFacts,
  indexFacts,
  sqlTableName,
} from '../testing/tableFacts';

import { transactionSettlementState, transactions } from './transactions';

/**
 * The contract's spelling of the money value and the merchant category, written
 * out here rather than imported. `packages/contracts-service-a` does not exist
 * yet, and once it does this package must not import it any more than the
 * reverse — the cases below assert that the two vocabularies were chosen
 * independently, which a shared constant would undo.
 */
const CONTRACT_TRANSACTION_FIELDS = ['amount', 'merchant_category', 'category', 'status'] as const;

/**
 * What this file pins that `transactions.test-d.ts` cannot: the SQL names, the
 * two foreign keys and their `ON DELETE` actions, the enum's type name, and the
 * index — none of which reach any inferred type, and the last of which is
 * invisible to every gate in the verification order.
 */
describe('transactions table', () => {
  it('reaches SQL as `transactions`', () => {
    expect(sqlTableName(transactions)).toBe('transactions');
  });

  it('maps each TypeScript property onto a deliberately un-contract-like column', () => {
    expect(columnFacts(transactions)).toEqual({
      id: {
        sqlName: 'id',
        sqlType: 'uuid',
        notNull: true,
        hasDefault: true,
        isPrimaryKey: true,
        isUnique: false,
      },
      cardId: {
        sqlName: 'card_id',
        sqlType: 'uuid',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
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
      bookedAt: {
        sqlName: 'booked_at',
        sqlType: 'timestamp with time zone',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      amountMinorUnits: {
        sqlName: 'amount_minor_units',
        sqlType: 'integer',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      currencyCode: {
        sqlName: 'currency_code',
        sqlType: 'char(3)',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      merchantName: {
        sqlName: 'merchant_name',
        sqlType: 'text',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      merchantCategoryCode: {
        sqlName: 'merchant_category_code',
        sqlType: 'char(4)',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      settlementState: {
        sqlName: 'settlement_state',
        sqlType: 'transaction_settlement_state',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
    });
  });

  it('stores money as a flat minor-unit and code pair, not as the contract publishes it', () => {
    // The contract publishes one money object per amount. Here the two halves
    // are separate columns and neither is called what the payload calls it, so
    // assembling the pair is `service-a`'s transaction mapper doing real work
    // rather than renaming a field. `integer` is asserted above: never a float,
    // never a preformatted string.
    const sqlNames = Object.values(columnFacts(transactions)).map((facts) => facts.sqlName);

    expect(sqlNames).toContain('amount_minor_units');
    expect(sqlNames).toContain('currency_code');
    CONTRACT_TRANSACTION_FIELDS.forEach((candidate) => {
      expect(sqlNames).not.toContain(candidate);
    });
  });

  it('stores a raw MCC rather than the contract\'s coarse category', () => {
    // ISO-18245 merchant category codes are an open set the card networks
    // extend without asking, so the provider cannot enumerate them: `char(4)`
    // and not an enum. That openness is the concrete reason spec §2.5 requires
    // an explicit `unknown` member on the contract's category enum — a code the
    // mapper has never seen degrades to `unknown` instead of failing a
    // response, and a new MCC is therefore not a contract change.
    const merchantCategoryCode = columnFacts(transactions).merchantCategoryCode;

    expect(merchantCategoryCode?.sqlType).toBe('char(4)');
  });

  it('points both foreign keys at their parents and refuses to drop a financial record', () => {
    // RESTRICT on both, unlike `spend_limits`, which cascades from cards: a
    // spend limit is configuration and a transaction is a ledger row.
    //
    // The two keys together do NOT enforce that `company_id` matches the card's
    // company — that needs a composite key against `cards (id, company_id)`.
    // Until then the invariant belongs to the seed and the repository layer,
    // which is stated in the module header rather than left to be discovered
    // from a mismatched row.
    expect(foreignKeyFacts(transactions)).toEqual([
      {
        columns: ['card_id'],
        referencedTable: 'cards',
        referencedColumns: ['id'],
        onDelete: 'restrict',
      },
      {
        columns: ['company_id'],
        referencedTable: 'companies',
        referencedColumns: ['id'],
        onDelete: 'restrict',
      },
    ]);
  });

  it('indexes the company and booking timestamp the mobile view reads by', () => {
    // Both reads the screen drives are `WHERE company_id = $1 ORDER BY
    // booked_at DESC`: the three latest transactions, and the paginated view
    // behind `54 more items`. Nothing in the verification order can see an
    // index, so a refactor that drops this one is otherwise a silent
    // seq-scan regression.
    //
    // Ascending on purpose despite the descending sort. Drizzle's index builder
    // renders `.desc()` as `DESC NULLS LAST` — the opposite of Postgres's
    // default for a descending sort — and the planner matches a pathkey
    // literally, so such an index is unusable by a plain `ORDER BY booked_at
    // DESC` even on a NOT NULL column. An ascending index carries no qualifier
    // and is simply read backwards.
    expect(indexFacts(transactions)).toEqual([
      {
        name: 'transactions_company_id_booked_at_idx',
        columns: ['company_id', 'booked_at'],
        unique: false,
        method: 'btree',
      },
    ]);
  });

  it('declares the settlement states the provider knows about', () => {
    expect(transactionSettlementState.enumName).toBe('transaction_settlement_state');
    expect(transactionSettlementState.enumValues).toEqual([
      'authorised',
      'settled',
      'reversed',
      'disputed',
    ]);
  });

  it('keeps `settled`, which the remaining-spend calculation filters on', () => {
    // The one member another module depends on by name: `service-a`'s dashboard
    // mapper computes remaining spend as the cap minus the sum of settled
    // amounts. Renaming it is a silent behaviour change everywhere else.
    expect(transactionSettlementState.enumValues).toContain('settled');
  });

  it('gives the database enum no `unknown` member', () => {
    // Spec §2.5's unknown member protects a consumer reading a value its pinned
    // contract version predates. A database enum has no such reader, so
    // mirroring the convention would publish a state no transaction is ever in.
    expect(transactionSettlementState.enumValues).not.toContain('unknown');
  });
});
