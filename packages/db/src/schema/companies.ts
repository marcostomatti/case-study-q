/**
 * The `companies` table: the entity behind the company selector at the top of
 * the mobile view, and the tenant every other row in this schema hangs off.
 *
 * Column names here are deliberately unlike the field names
 * `packages/contracts-service-a` will publish. That is the point of spec §2.1:
 * the contract is hand-authored and a mapping layer in `service-a` translates
 * between the two, so renaming a column is a migration rather than a breaking
 * change to every consumer. A schema derived from these tables — via
 * `drizzle-zod` or `drizzle-typebox` — would make `registered_legal_name` part
 * of the published API and this file's naming a consumer-visible decision.
 *
 * Two of those differences are load-bearing rather than cosmetic:
 *
 *   - `registered_legal_name` and `display_name` are separate columns because
 *     they are separate facts. The selector renders `Company AB`; the
 *     registered name is what appears on an invoice. A contract exposing one
 *     `name` field is free to choose either without a migration.
 *   - `default_currency_code` carries no SQL `DEFAULT`. Money in this repo is
 *     always an integer minor-unit amount paired with an explicit ISO-4217
 *     code, so a currency that can be omitted at insert time is exactly the
 *     ambiguity that convention exists to remove.
 */
import { char, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * `NNNNNN-NNNN` — the Swedish organisation number the seeded `Company AB`
 * carries. Length is pinned rather than left to `text` so a malformed value
 * fails at the database rather than at whichever reader notices first.
 */
const ORGANISATION_NUMBER_LENGTH = 11;

/** ISO-4217 alphabetic codes are exactly three characters. */
const CURRENCY_CODE_LENGTH = 3;

export const companies = pgTable('companies', {
  id: uuid('id').primaryKey()
    .defaultRandom(),
  registeredLegalName: text('registered_legal_name').notNull(),
  displayName: text('display_name').notNull(),
  organisationNumber: varchar('organisation_number', {
    length: ORGANISATION_NUMBER_LENGTH,
  }).notNull()
    .unique(),
  defaultCurrencyCode: char('default_currency_code', {
    length: CURRENCY_CODE_LENGTH,
  }).notNull(),
});

/** A company row as it comes back from a query. */
export type Company = typeof companies.$inferSelect;

/** A company row as it goes in. `id` is optional: the database generates it. */
export type NewCompany = typeof companies.$inferInsert;
