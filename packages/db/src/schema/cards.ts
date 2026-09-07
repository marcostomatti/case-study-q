/**
 * The `cards` table: the card rendered in the middle of the mobile view, and
 * the row `activateCard` transitions.
 *
 * This is where the contract/database boundary earns its keep, so the naming
 * divergence is deliberate and worth stating rather than discovering:
 *
 *   - **`lifecycle_status` is the column the contract calls something else.**
 *     `service-a`'s card mapper translates it, which is the whole reason a
 *     mapping layer exists (spec §2.1). Renaming this column is a migration
 *     the provider owns; renaming the contract's field is a breaking change
 *     every consumer has to be told about. Keeping the two spelled differently
 *     is what stops the second from being mistaken for the first.
 *   - **The database enum carries no `unknown` member.** Spec §2.5 requires an
 *     explicit unknown member on every *contract* enum so a consumer pinned to
 *     an older version survives a value it has never seen. A database enum has
 *     no such reader — every value in it is one the schema declared — so
 *     mirroring the convention here would publish a state no card is ever in.
 *     The mapper folds anything it does not recognise onto the contract's
 *     `unknown`, which is what makes adding a member below a non-breaking
 *     change rather than a coordinated deploy.
 *   - **`pan_last_four` is four characters of a card number, never the number.**
 *     Spelled with `pan_` so a reader cannot mistake it for a display string,
 *     and stored as `char(4)` so a full PAN does not fit.
 *
 * `activated_at` is nullable, and that nullability is the one fact the
 * contract must not inherit. Spec §2.5 says `null` is never emitted and absent
 * means not applicable, so the mapper omits the field for a card that has not
 * been activated rather than passing the `null` through.
 */
import { char, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { companies } from './companies';

/** A masked PAN suffix is exactly four digits. */
const PAN_LAST_FOUR_LENGTH = 4;

/**
 * The states a card moves through, provider-side. Ordered as the card travels:
 * ordered by the company, issued by the processor, activated by the cardholder,
 * frozen reversibly, terminated permanently.
 *
 * Deliberately not the contract's vocabulary. A consumer never learns that
 * `ordered` and `issued` are distinct here.
 */
export const cardLifecycleStatus = pgEnum('card_lifecycle_status', [
  'ordered',
  'issued',
  'active',
  'frozen',
  'terminated',
]);

export const cards = pgTable('cards', {
  id: uuid('id').primaryKey()
    .defaultRandom(),
  companyId: uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'restrict' }),
  panLastFour: char('pan_last_four', { length: PAN_LAST_FOUR_LENGTH }).notNull(),
  lifecycleStatus: cardLifecycleStatus('lifecycle_status').notNull(),
  // Null until the cardholder activates. The mapper turns that into an absent
  // contract field, never a `null` one.
  activatedAt: timestamp('activated_at', { withTimezone: true, mode: 'date' }),
  // An opaque key into whatever serves card artwork. Not a URL: the contract
  // publishes a resolved reference, and the resolution is the service's
  // business rather than a column consumers can start depending on.
  artAssetKey: text('art_asset_key').notNull(),
});

/** A card row as it comes back from a query. */
export type Card = typeof cards.$inferSelect;

/** A card row as it goes in. `id` is optional: the database generates it. */
export type NewCard = typeof cards.$inferInsert;

/** The database's own card states — not the contract's, and without `unknown`. */
export type CardLifecycleStatus = Card['lifecycleStatus'];
