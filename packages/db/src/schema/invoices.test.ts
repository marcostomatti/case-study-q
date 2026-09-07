import { describe, expect, it } from 'vitest';

import {
  columnFacts,
  foreignKeyFacts,
  indexFacts,
  sqlTableName,
} from '../testing/tableFacts';

import { invoicePaymentState, invoices } from './invoices';

/**
 * The contract's spelling of the invoice fields, written out here rather than
 * imported. `packages/contracts-service-b` does not exist yet, and once it does
 * this package must not import it any more than the reverse — the cases below
 * assert that the two vocabularies were chosen independently, which a shared
 * constant would undo.
 */
const CONTRACT_INVOICE_FIELDS = ['amount', 'due_date', 'status', 'state'] as const;

/**
 * What this file pins that `invoices.test-d.ts` cannot: the SQL names, the
 * foreign key and its `ON DELETE` action, the enum's type name and members, and
 * the index — none of which reach any inferred type, and the last of which is
 * invisible to every gate in the verification order.
 *
 * The reverse split matters more here than for any other table in this schema:
 * `due_on` renders as `date` whichever drizzle `mode` it was given, so nothing
 * in this file can tell a `string` due date from a `Date` one. That claim is
 * `invoices.test-d.ts`'s alone.
 */
describe('invoices table', () => {
  it('reaches SQL as `invoices`', () => {
    expect(sqlTableName(invoices)).toBe('invoices');
  });

  it('maps each TypeScript property onto a deliberately un-contract-like column', () => {
    expect(columnFacts(invoices)).toEqual({
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
      dueOn: {
        // `date`, not `timestamp with time zone` — the only temporal column in
        // this schema that is a calendar day rather than an instant. A widening
        // to `timestamptz` for symmetry with `booked_at` fails here first.
        sqlName: 'due_on',
        sqlType: 'date',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      totalMinorUnits: {
        sqlName: 'total_minor_units',
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
      paymentState: {
        sqlName: 'payment_state',
        sqlType: 'invoice_payment_state',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
    });
  });

  it('names no column the way the contract will name its field', () => {
    const sqlNames = Object.values(columnFacts(invoices)).map((facts) => facts.sqlName);

    CONTRACT_INVOICE_FIELDS.forEach((candidate) => {
      expect(sqlNames).not.toContain(candidate);
    });
  });

  it('stores its own currency code, unlike `spend_limits`', () => {
    // An invoice is denominated when it is issued, so it carries the code with
    // it: a company that later changes `default_currency_code` must not
    // re-denominate an invoice already sent. A spend limit is configuration and
    // deliberately has no such column. Asserting both halves is what stops the
    // two tables being unified for consistency.
    const sqlNames = Object.values(columnFacts(invoices)).map((facts) => facts.sqlName);

    expect(sqlNames).toContain('currency_code');
    expect(sqlNames).toContain('total_minor_units');
  });

  it('restricts on company delete, as every financial record here does', () => {
    // `spend_limits` cascades because it is configuration scoped to a card.
    // An invoice is a financial record and must not vanish with its company.
    expect(foreignKeyFacts(invoices)).toEqual([
      {
        columns: ['company_id'],
        referencedTable: 'companies',
        referencedColumns: ['id'],
        onDelete: 'restrict',
      },
    ]);
  });

  it('indexes company then due date, ascending, in that order', () => {
    // The banner's only read: the earliest `issued` invoice for a company.
    // Column order is asserted, not the set — a composite index serves only the
    // prefixes of its own ordering. Ascending for the reason spelled out in
    // `transactions.ts`; here it is also the direction the query sorts, so the
    // index is read forwards.
    expect(indexFacts(invoices)).toEqual([
      {
        name: 'invoices_company_id_due_on_idx',
        columns: ['company_id', 'due_on'],
        unique: false,
        method: 'btree',
      },
    ]);
  });

  it('declares the payment states the provider knows about', () => {
    expect(invoicePaymentState.enumName).toBe('invoice_payment_state');
    expect(invoicePaymentState.enumValues).toEqual([
      'draft',
      'issued',
      'paid',
      'written_off',
    ]);
  });

  it('keeps `issued`, which the due-invoice lookup filters on', () => {
    // The one member another module depends on by name: `service-b` reads the
    // earliest `issued` invoice to decide whether the banner shows at all.
    // Renaming it is a change to that query, not just to this enum.
    expect(invoicePaymentState.enumValues).toContain('issued');
  });

  it('gives the database enum no `overdue` member, because that is a comparison', () => {
    // Whether an invoice is due is `due_on` against today. A stored `overdue`
    // is a second source of truth that goes stale at midnight with nothing to
    // recompute it — the same argument as `spend_limits` storing no
    // `remaining` column, and the reason the contract's banner field cannot be
    // derived from any single column here.
    expect(invoicePaymentState.enumValues).not.toContain('overdue');
  });

  it('gives the database enum no `unknown` member', () => {
    // Spec §2.5's unknown member protects a consumer reading a value its pinned
    // contract version predates. A database enum has no such reader, so
    // mirroring the convention would publish a state no invoice is ever in.
    expect(invoicePaymentState.enumValues).not.toContain('unknown');
  });
});
