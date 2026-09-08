/**
 * The company reads, against a real Postgres.
 *
 * Two things this file is for beyond "the query runs". First, that
 * `findCompanyById` hands back the **Drizzle row** — all five columns,
 * including the three the contract does not publish — because the moment a
 * repository starts narrowing, the decision about what a consumer sees has
 * moved out of `mapping/` and spec section 2.1's argument is being made in two
 * places. Second, that offset paging over this table is a **total** order: a
 * missing tie-break loses rows across pages and no single response shows it.
 *
 * Every absence case is asserted against a database that could have answered
 * — either the seeded one with a different identifier, or an empty one beside
 * a positive control on the seeded one. `null` from a query that looked
 * somewhere else entirely reads exactly the same.
 */
import type { ServiceDatabase } from './database';
import type { SeededPostgres } from '../testing/seededDatabase';
import type { NewCompany } from '@marcos-corp/db';

import { companies } from '@marcos-corp/db';
import { SEED_COMPANY_ID } from '@marcos-corp/db/seed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SEEDED_DATABASE_TIMEOUT_MS, startSeededDatabase } from '../testing/seededDatabase';

import { findCompanyById, listCompanies } from './companyRepository';
import { PageRequestError } from './pagination';

/** An identifier no seeded row carries, and a legal uuid so it reaches SQL. */
const UNKNOWN_COMPANY_ID = '99999999-9999-4999-8999-999999999999';

/** The whole seeded company, spelled out. See the header for why all five. */
const SEEDED_COMPANY = {
  id: SEED_COMPANY_ID,
  registeredLegalName: 'Company Sverige Aktiebolag',
  displayName: 'Company AB',
  organisationNumber: '556677-8899',
  defaultCurrencyCode: 'SEK',
};

/**
 * Three companies sharing one display name, so the ordering has ties to break.
 * Written out of alphabetical and out of identifier order, so a query that
 * returns them in insertion order fails.
 */
const TIED: NewCompany[] = [
  {
    id: '0000000c-0000-4000-8000-000000000003',
    registeredLegalName: 'Tied Three AB',
    displayName: 'Tied AB',
    organisationNumber: '100000-0003',
    defaultCurrencyCode: 'SEK',
  },
  {
    id: '0000000a-0000-4000-8000-000000000001',
    registeredLegalName: 'Tied One AB',
    displayName: 'Tied AB',
    organisationNumber: '100000-0001',
    defaultCurrencyCode: 'SEK',
  },
  {
    id: '0000000b-0000-4000-8000-000000000002',
    registeredLegalName: 'Tied Two AB',
    displayName: 'Tied AB',
    organisationNumber: '100000-0002',
    defaultCurrencyCode: 'SEK',
  },
];

/** Sorts before every `Tied AB`, so it is the first page of the ordered set. */
const FIRST_BY_NAME: NewCompany = {
  id: '0000000d-0000-4000-8000-000000000004',
  registeredLegalName: 'Alfa Sverige AB',
  displayName: 'Alfa AB',
  organisationNumber: '100000-0004',
  defaultCurrencyCode: 'SEK',
};

let postgres: SeededPostgres;
let seeded: ServiceDatabase;
let empty: ServiceDatabase;
let ordered: ServiceDatabase;

beforeAll(async () => {
  postgres = await startSeededDatabase();
  seeded = postgres.db;
  empty = await postgres.createEmptyDatabase();

  ordered = await postgres.createEmptyDatabase();
  await ordered.insert(companies).values([FIRST_BY_NAME, ...TIED]);
}, SEEDED_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await postgres?.stop();
});

describe('findCompanyById', () => {
  it('returns the whole Drizzle row, including the columns the contract omits', async () => {
    // `toStrictEqual`, so a column added to `companies` without a decision
    // taken about it fails here rather than arriving silently in whatever
    // reads this row next.
    await expect(findCompanyById(seeded, SEED_COMPANY_ID)).resolves.toStrictEqual(SEEDED_COMPANY);
  });

  it('returns null for an identifier no row carries', async () => {
    await expect(findCompanyById(seeded, UNKNOWN_COMPANY_ID)).resolves.toBeNull();
    // The control: the same database, the same call, an identifier that exists.
    await expect(findCompanyById(seeded, SEED_COMPANY_ID)).resolves.not.toBeNull();
  });

  it('returns null against a database with no companies at all', async () => {
    await expect(findCompanyById(empty, SEED_COMPANY_ID)).resolves.toBeNull();
    await expect(findCompanyById(seeded, SEED_COMPANY_ID)).resolves.not.toBeNull();
  });
});

describe('listCompanies', () => {
  it('lists the seeded company and counts it once', async () => {
    const page = await listCompanies(seeded, { limit: 20, offset: 0 });

    expect(page.items).toStrictEqual([SEEDED_COMPANY]);
    expect(page.total).toBe(1);
  });

  it('returns nothing and a total of nothing from an empty database', async () => {
    const page = await listCompanies(empty, { limit: 20, offset: 0 });

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('orders by display name, then by identifier where the names tie', async () => {
    // Without the tie-break the three `Tied AB` rows come back in whatever
    // order the plan produces, and the paging case below stops meaning
    // anything.
    const page = await listCompanies(ordered, { limit: 20, offset: 0 });

    expect(page.items.map((row) => row.registeredLegalName)).toEqual([
      'Alfa Sverige AB',
      'Tied One AB',
      'Tied Two AB',
      'Tied Three AB',
    ]);
  });

  it('pages through a tied set without repeating or skipping a row', async () => {
    // The claim the tie-break exists for. Three of these four rows share a
    // display name, so an unstable sort is free to hand the same row to two
    // pages and never hand over a third — which every individual page would
    // still look correct.
    const first = await listCompanies(ordered, { limit: 2, offset: 0 });
    const second = await listCompanies(ordered, { limit: 2, offset: 2 });
    const seen = [...first.items, ...second.items].map((row) => row.id);

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(first.total).toBe(4);
  });

  it('counts the whole collection, not the page it returned', async () => {
    const page = await listCompanies(ordered, { limit: 1, offset: 0 });

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(4);
  });

  it('returns an empty page past the end, and still the true total', async () => {
    const page = await listCompanies(ordered, { limit: 2, offset: 40 });

    expect(page.items).toEqual([]);
    expect(page.total).toBe(4);
  });

  it('refuses a page the contract does not publish, before it reaches SQL', async () => {
    await expect(listCompanies(seeded, { limit: 0, offset: 0 }))
      .rejects.toBeInstanceOf(PageRequestError);
  });
});
