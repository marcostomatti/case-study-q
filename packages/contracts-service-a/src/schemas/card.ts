/**
 * The card in the middle of the mobile view: the artwork, the digits under it,
 * and the state the `Activate card` button at the bottom of the screen reads.
 *
 * ## The state enum is the reason this file matters
 *
 * `cards.lifecycle_status` in `@marcos-corp/db` has five members — `ordered`,
 * `issued`, `active`, `frozen`, `terminated` — and no `unknown`. This enum has
 * four members and an `unknown`, and neither difference is cosmetic:
 *
 * - **It is coarser.** `ordered` and `issued` are the provider's issuing
 *   pipeline. A consumer branches on whether the card is usable and whether to
 *   offer activation, and both of those answers are the same for a card the
 *   cardholder has not activated yet. Both fold onto `inactive`. The enum is
 *   not a permission model: `activateCard` is the authority on whether an
 *   activation succeeds, and answers `conflict` when it does not.
 * - **It carries `unknown`, which the database enum must not** (spec §2.5).
 *   That member is what makes adding a provider-side state a non-breaking
 *   change: a consumer pinned to a version predating it folds the value onto
 *   `unknown` and keeps rendering, instead of throwing on a payload it
 *   validated a moment ago. The mapper in `services/service-a` is where the
 *   fold happens, and the member is what gives it somewhere to fold onto.
 *
 * Built with `Type.Unsafe` rather than `Type.Union([Type.Literal(...)])`. The
 * idiomatic TypeBox spelling emits `anyOf` of `const`s, which is an enum a
 * human reads as an enum and which house rule 3 — whose `given` selects nodes
 * carrying `enum` — never sees. Spec §2.5's unknown-member requirement would
 * be unenforced on the one schema in this contract most likely to grow a value.
 *
 * ## Two fields that publish data rather than presentation
 *
 * - **`lastFour` is four digits, never a rendered mask.** A consumer draws
 *   `•••• 4321` however its platform draws it. Publishing the masked string
 *   would move the provider's formatting into every consumer and make it
 *   unusable for anything but display — the same mistake as a preformatted
 *   money string, which `MonetaryAmount` exists to avoid. It is also the only
 *   part of the PAN this contract ever carries.
 * - **`artUrl` is a resolved URL, not the database's `art_asset_key`.**
 *   Publishing the opaque key would make the provider's asset store a
 *   consumer dependency: every client would need to know how to turn
 *   `card-art/business-black-v2` into something fetchable, and moving the
 *   artwork to a different CDN would become a contract change. Resolving it is
 *   the service's business, which is what the column's own note in
 *   `packages/db` promises.
 *
 * `activatedAt` is the contract's worked example of the absent-not-null
 * convention. The column behind it is nullable, and that nullability is the one
 * fact the contract must not inherit: an unactivated card omits the field
 * rather than carrying a `null` for it (spec §2.5, and house rule 6 rejects
 * both spellings of the alternative).
 */
import type { Static } from '@sinclair/typebox';

import { Type } from '@sinclair/typebox';

import { responseObject, Timestamp } from './shared';

/**
 * Defensive upper bound on an identifier arriving in a request. See
 * `COMPANY_ID_MAX_LENGTH` in `./company` for why the two are stated separately
 * rather than shared.
 */
const CARD_ID_MAX_LENGTH = 64;

/** A masked PAN suffix is exactly four digits — both bounds and the pattern. */
const LAST_FOUR_LENGTH = 4;

/** Digits only. A pattern alone is easy to widen; the lengths pin it. */
const LAST_FOUR_PATTERN = '^[0-9]{4}$';

/**
 * A card identifier, as it appears in the activation path and in a response.
 *
 * Opaque and without `format: 'uuid'`, for the reason `CompanyId` gives: the
 * key scheme behind it is the provider's to change. No `$id`, for the reason
 * every scalar in this package lacks one.
 *
 * The example is the identifier `packages/db`'s seed inserts, so the Prism mock
 * and a running `service-a` answer with the same value.
 */
export const CardId = Type.String({
  description: 'Opaque card identifier. Echo it back; never parse it.',
  minLength: 1,
  maxLength: CARD_ID_MAX_LENGTH,
  examples: ['22222222-2222-4222-8222-222222222222'],
});
export type CardId = Static<typeof CardId>;

/**
 * What a card can be, from the cardholder's side.
 *
 * Ordered as a card travels: not yet activated, usable, temporarily blocked,
 * permanently gone — then the member that is not a state at all.
 *
 * A consumer's `switch` over these must be exhaustive, `unknown` included. That
 * is the half of spec §2.5 a schema cannot enforce on its own, so `web-b`
 * carries a test asserting it folds an unrecognised value onto `unknown` and
 * keeps going.
 */
export const CARD_STATES = [
  // Issued to the company but not activated by the cardholder — the state the
  // screen's `Activate card` button exists for. The provider distinguishes a
  // card it has ordered from one the processor has issued; a consumer does not.
  'inactive',
  // Activated and usable.
  'active',
  // Blocked, reversibly. Nothing to do here but tell the cardholder.
  'frozen',
  // Terminated. Permanent, and no action restores it.
  'closed',
  // Not in this list. Emitted by a provider reporting a state added after the
  // consumer's pinned version, and folded onto by a consumer receiving one.
  'unknown',
] as const;

/** The union a consumer's `switch` is exhaustive against. */
export type CardState = (typeof CARD_STATES)[number];

/**
 * `state` as a schema. See the header for why this is `Type.Unsafe` and not the
 * idiomatic union of literals.
 */
export const CardState = Type.Unsafe<CardState>({
  type: 'string',
  enum: [...CARD_STATES],
  description: 'Card state. Unrecognised values are `unknown`.',
});

/**
 * The card the mobile view renders, and the payload `activateCard` answers
 * with.
 *
 * Carries an `$id` because it is reused: the dashboard embeds it and the
 * activation operation returns it, and one component means an edit reads as a
 * single change in the diff gate.
 *
 * It carries no `companyId`. The card is reached through a company the caller
 * already selected, so repeating it would publish a second source of the same
 * truth — and one the provider would then be obliged to keep consistent.
 */
export const Card = responseObject({
  id: CardId,
  lastFour: Type.String({
    description: 'Last four digits of the card number. Mask them client-side.',
    pattern: LAST_FOUR_PATTERN,
    minLength: LAST_FOUR_LENGTH,
    maxLength: LAST_FOUR_LENGTH,
    examples: ['4321'],
  }),
  state: CardState,
  artUrl: Type.String({
    description: 'Absolute URL of the card artwork, resolved by the provider.',
    format: 'uri',
    minLength: 1,
    examples: ['https://cdn.example.com/card-art/business-black-v2.png'],
  }),
  // Reuses the shared instant and restates only what the field means. The
  // spread keeps TypeBox's `Kind` symbol, so this is still the same schema —
  // verified by the emitted JSON in `card.test.ts`.
  activatedAt: Type.Optional({
    ...Timestamp,
    description: 'When the cardholder activated the card. Absent if not.',
  }),
}, {
  $id: 'Card',
  description: 'The card the dashboard renders and the activation returns.',
});
export type Card = Static<typeof Card>;
