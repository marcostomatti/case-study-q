import { describe, expect, it } from 'vitest';

import { columnFacts, sqlTableName } from '../testing/tableFacts';

import { companies } from './companies';

/**
 * What this file pins that `companies.test-d.ts` cannot.
 *
 * An inferred row type erases every SQL name: `Company` reads
 * `registeredLegalName: string` whether the column is `registered_legal_name`,
 * `legal_name` or `name`. The naming divergence between this table and the
 * contract is the premise of spec §2.1's mapping layer, so it needs an
 * assertion that survives a rename — and only the runtime table object carries
 * one.
 *
 * The exhaustive `toEqual` below is deliberate. A per-column check passes just
 * as happily when a column is added or dropped, which is the change most
 * likely to arrive without anyone revisiting this file.
 */
describe('companies table', () => {
  it('reaches SQL as `companies`', () => {
    expect(sqlTableName(companies)).toBe('companies');
  });

  it('maps each TypeScript property onto a deliberately un-contract-like column', () => {
    expect(columnFacts(companies)).toEqual({
      id: {
        sqlName: 'id',
        sqlType: 'uuid',
        notNull: true,
        hasDefault: true,
        isPrimaryKey: true,
        isUnique: false,
      },
      registeredLegalName: {
        sqlName: 'registered_legal_name',
        sqlType: 'text',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      displayName: {
        sqlName: 'display_name',
        sqlType: 'text',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      organisationNumber: {
        sqlName: 'organisation_number',
        sqlType: 'varchar(11)',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: true,
      },
      defaultCurrencyCode: {
        sqlName: 'default_currency_code',
        sqlType: 'char(3)',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
    });
  });

  it('keeps the registered and displayed names as separate columns', () => {
    const facts = columnFacts(companies);

    // The selector in the mobile view renders `Company AB`; an invoice needs
    // the registered name. A contract publishing a single `name` field can
    // pick either without a migration only while both are stored.
    expect(facts.registeredLegalName?.sqlName).not.toBe(facts.displayName?.sqlName);
  });

  it('lets the database fill only `id`, so it is the sole omittable insert field', () => {
    const generated = Object.entries(columnFacts(companies))
      .filter(([, facts]) => facts.hasDefault)
      .map(([property]) => property);

    // Read together with the `NewCompany` case in `companies.test-d.ts`: this
    // is the runtime cause, that is the type-level effect. A SQL default added
    // to any other column silently makes its contract-side counterpart
    // optional too.
    expect(generated).toEqual(['id']);
  });

  it('gives the currency no SQL default, so every insert states one', () => {
    // Money in this repo is an integer minor-unit amount plus an explicit
    // ISO-4217 code. A currency that can be omitted at insert time is exactly
    // the ambiguity that convention removes, so this is a governance
    // assertion rather than a schema detail.
    expect(columnFacts(companies).defaultCurrencyCode?.hasDefault).toBe(false);
  });

  it('constrains the organisation number, and nothing else, to be unique', () => {
    const unique = Object.entries(columnFacts(companies))
      .filter(([, facts]) => facts.isUnique)
      .map(([property]) => property);

    expect(unique).toEqual(['organisationNumber']);
  });
});
