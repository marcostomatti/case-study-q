/**
 * The company a card, a spend limit and a transaction all hang off, as the
 * company selector at the top of the mobile view needs it.
 *
 * The selector renders one line per company — `Company AB` with a chevron — and
 * selecting one is what every other operation in this contract is scoped by. So
 * this schema is a *summary*: what the selector draws and what the next request
 * needs, and nothing else.
 *
 * ## Why the summary is this small
 *
 * `companies` in `@marcos-corp/db` carries a registered legal name, a display
 * name, an organisation number and a default currency. None of the three this
 * schema omits reaches the screen, and publishing a field costs more than
 * leaving it out: removing a required response property later is breaking
 * (`response-required-property-removed`, which fails gate 3 and forces the
 * major-version procedure in spec §6.2), while adding one is the additive
 * change spec §6.1 lets a consumer author and ship the same day. The cheap
 * direction is the one to leave room in.
 *
 * That asymmetry is the whole argument for hand-authoring this package. A
 * schema derived from the table would publish all four columns because they
 * happen to be there, and every one of them would then be a field the provider
 * owes a consumer forever.
 *
 * ## Two shapes the divergence takes here
 *
 * - **One `name` where the database has two columns.** `registered_legal_name`
 *   is what an invoice is issued to; `display_name` is what the selector draws.
 *   They are separate facts, and the contract publishes the one the screen
 *   asks for. Which column feeds it is `service-a`'s mapping decision — moving
 *   it is a provider-side change no consumer can see.
 * - **`id` is opaque, and deliberately carries no `format: 'uuid'`.** The
 *   column behind it is a `uuid` today. Stating that here would publish the
 *   provider's key scheme and make migrating off it a contract change, which is
 *   the same reason `MonetaryAmount` states no ceiling for a column that is a
 *   32-bit integer. A consumer echoes this value back; it never parses it.
 */
import type { Static } from '@sinclair/typebox';

import { Type } from '@sinclair/typebox';

import { responseObject } from './shared';

/**
 * Defensive upper bound on an identifier arriving in a request.
 *
 * Stated per identifier rather than shared with `CardId`: they are two
 * independent contract decisions, and a single component for "an id" is how
 * loosening one silently loosens the other. The number is a bound, not a
 * format — it says what the provider will read, not what the value looks like.
 */
const COMPANY_ID_MAX_LENGTH = 64;

/**
 * A company identifier, as it appears in a path and in a response.
 *
 * No `$id`. `emitOpenApi` hoists on `$id`, and a component per string type puts
 * the constraint a reviewer is checking one indirection away from the field it
 * constrains — the convention `shared.ts` sets for every scalar. A path
 * parameter could not use a hoisted component anyway: those are exploded into
 * `parameters` rather than referenced.
 *
 * The example is the identifier `packages/db`'s seed inserts, so the Prism mock
 * and a running `service-a` answer the same request with the same id. That is
 * what makes the mock usable for the unblocking workflow in spec §6.1 rather
 * than merely well-formed. An example is not a constraint: it illustrates the
 * value, it does not license parsing it.
 */
export const CompanyId = Type.String({
  description: 'Opaque company identifier. Echo it back; never parse it.',
  minLength: 1,
  maxLength: COMPANY_ID_MAX_LENGTH,
  examples: ['11111111-1111-4111-8111-111111111111'],
});
export type CompanyId = Static<typeof CompanyId>;

/**
 * A company as the selector lists it, and as the dashboard names the one in
 * view.
 *
 * Carries an `$id` because it is reused across operations — the list of
 * companies and the selected company on the dashboard are the same shape. One
 * component means an edit to it reads as a single change in the diff gate
 * rather than one per usage, and a consumer binds to one type.
 *
 * `name` states `minLength: 1` for the same reason the error payload's message
 * does: an empty string would be a second spelling of "nothing here", and spec
 * §2.5 allows exactly one — absence.
 */
export const CompanySummary = responseObject({
  id: CompanyId,
  name: Type.String({
    description: 'The company name the selector renders.',
    minLength: 1,
    examples: ['Company AB'],
  }),
}, {
  $id: 'CompanySummary',
  description: 'A company as the selector lists it.',
});
export type CompanySummary = Static<typeof CompanySummary>;
