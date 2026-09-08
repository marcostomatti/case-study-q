/**
 * The primitives `service-b`'s contract reuses: a monetary amount, a calendar
 * date, the company identifier its one operation is scoped by, and the two
 * object builders that carry spec §2.5's request/response asymmetry.
 *
 * Everything here is hand-authored TypeBox and derived from nothing — in
 * particular not from `@marcos-corp/db` (spec §2.1), which this package must
 * not depend on. `invoices` stores money as two flat columns and a payment
 * state in the provider's own vocabulary; this contract publishes one money
 * object and a coarser enum, and `services/service-b` is where the two are
 * translated. That gap is what keeps a column rename from being a contract
 * break.
 *
 * ## Why this is a second copy rather than an import from `contracts-service-a`
 *
 * The two contract packages publish the same money shape and use the same
 * builders, and importing one from the other would be the obvious way to say
 * so. It is also the one thing that would undo the property this PoC is built
 * to demonstrate: the packages are **versioned independently** (spec §2.2, and
 * `docs/governance.md` records the decision), so a consumer pins each one on
 * its own. A shared runtime dependency between them makes every edit to
 * `contracts-service-a` a candidate version bump of `contracts-service-b`, and
 * every `service-b` consumer then reviews a change to an API it does not call.
 *
 * The duplication is small, deliberate, and cheaper than that coupling. Where
 * the two packages agree — `MonetaryAmount`'s shape, the `Error` component
 * name — they agree because both are stating the same house convention, not
 * because one is reading the other's source.
 *
 * ## The conventions this module encodes
 *
 * - **Money is an integer minor-unit value paired with an ISO-4217 code.** An
 *   invoice for `2 480,00 kr` is `{ minorUnits: 248000, currency: 'SEK' }`.
 *   Never a float — binary rounding loses cents on the one document a company
 *   is actually asked to pay — and never a preformatted string, which moves
 *   the provider's locale into every consumer.
 * - **A due date is a calendar day, not an instant.** See `CalendarDate`.
 * - **`additionalProperties` is decided by direction, not per call site.**
 *   Requests reject unknown fields; responses tolerate them (spec §2.5). The
 *   two builders below set it and `ContractObjectOptions` makes overriding it
 *   a `check-types` failure, which is what satisfies house rule 2 by
 *   construction rather than by everyone remembering.
 *
 * `null` appears nowhere. Absent means not applicable — one convention, with
 * house rule 6 rejecting both spellings of the other one.
 */
import type { Static, TObject, TProperties } from '@sinclair/typebox';

import { Type } from '@sinclair/typebox';

/**
 * The object options a contract author may set.
 *
 * `additionalProperties` is deliberately not among them: which way it goes is a
 * property of the direction the payload travels rather than of the individual
 * schema, so it belongs to the builder that knows the direction.
 *
 * Spelled out as its own interface rather than as
 * `Omit<ObjectOptions, 'additionalProperties'>`, which looks like the same
 * thing and states nothing — TypeBox's `SchemaOptions` carries an
 * `[prop: string]: any` index signature, so `Omit` drops every named member,
 * keeps the index signature, and hands the key straight back. The allow-list
 * below is the only form of this a compiler enforces, and `shared.test-d.ts`
 * carries the `@ts-expect-error` case that proves it bites.
 *
 * `deprecated` and `x-sunset` travel together because house rule 4 fails
 * anything marked deprecated without a date — the mechanism spec §6.4's field
 * retirement flow rests on.
 */
export interface ContractObjectOptions {
  /** Hoists the schema into `components.schemas` under this name. */
  $id?: string;
  /** Short label for the shape. */
  title?: string;
  /** What the shape means, for the consumer reading the document. */
  description?: string;
  /** Marks the shape for retirement. Requires `x-sunset` beside it. */
  deprecated?: boolean;
  /** `YYYY-MM-DD`, the date a deprecated shape goes away (spec §6.4). */
  'x-sunset'?: string;
  /** Sample payloads, which a mock server serves and a reader reads. */
  examples?: unknown[];
}

/**
 * An object a consumer reads. Tolerates unknown fields, always.
 *
 * The schema half of spec §2.5's "consumers ignore unknown response fields".
 * The provider deploys before the consumer adopts, so a consumer validating a
 * payload against its own pinned version routinely sees fields that version
 * predates. `additionalProperties: false` here would turn every additive
 * change — the one kind the diff gate lets through unreviewed — into a runtime
 * failure for exactly the consumers who did nothing wrong.
 */
export function responseObject<Properties extends TProperties>(
  properties: Properties,
  options: ContractObjectOptions = {},
): TObject<Properties> {
  return Type.Object(properties, { ...options, additionalProperties: true });
}

/**
 * An object a consumer sends. Rejects unknown fields.
 *
 * The other half of spec §2.5. Provider-first deploy ordering means the
 * provider already accepts a field before any consumer sends it, so strictness
 * costs nothing and a misspelled field is reported rather than silently
 * ignored.
 *
 * For a path-parameter container the emitted document never carries this
 * object — `emitOpenApi` explodes those into `parameters` — so the strictness
 * becomes the service's own to enforce. The schema still states it, because it
 * is what the provider validates against.
 */
export function requestObject<Properties extends TProperties>(
  properties: Properties,
  options: ContractObjectOptions = {},
): TObject<Properties> {
  return Type.Object(properties, { ...options, additionalProperties: false });
}

/** ISO-4217 alphabetic codes are exactly three uppercase letters. */
const CURRENCY_CODE_LENGTH = 3;

/** Both bounds as well as the pattern: a pattern alone is easy to widen. */
const CURRENCY_CODE_PATTERN = '^[A-Z]{3}$';

/** `YYYY-MM-DD` is ten characters, both bounds stated with the pattern. */
const CALENDAR_DATE_LENGTH = 10;

/**
 * Defensive upper bound on an identifier arriving in a request. Stated per
 * identifier rather than shared with `InvoiceId`: two identifiers are two
 * contract decisions, and one component for "an id" is how loosening one
 * silently loosens the other.
 */
const COMPANY_ID_MAX_LENGTH = 64;

/**
 * The currency a monetary amount is denominated in: an ISO-4217 alphabetic
 * code, uppercase.
 *
 * Deliberately not an enum. House rule 3 would then require an `unknown`
 * member, which for a published external standard is noise — ISO-4217 is not
 * this provider's vocabulary to extend, and a consumer receiving a code it does
 * not recognise has a currency, not an unknown state.
 */
export const CurrencyCode = Type.String({
  description: 'ISO-4217 alphabetic currency code, uppercase.',
  pattern: CURRENCY_CODE_PATTERN,
  minLength: CURRENCY_CODE_LENGTH,
  maxLength: CURRENCY_CODE_LENGTH,
  examples: ['SEK'],
});
export type CurrencyCode = Static<typeof CurrencyCode>;

/**
 * A monetary amount: an integer count of the currency's minor unit, plus the
 * currency it counts.
 *
 * `minorUnits` is **signed**, because a credit note is a negative invoice.
 * Forbidding the sign would push it into a second field or into a document
 * type, which is how a balance ends up computed with the wrong one.
 *
 * No upper bound is stated on purpose. The column behind this today is a
 * 32-bit `integer`, and widening it is a provider-side migration no consumer
 * can see — stating the column's ceiling here would publish an implementation
 * detail and make that migration a contract change.
 */
export const MonetaryAmount = responseObject({
  minorUnits: Type.Integer({
    description:
      'Signed amount in the currency\'s minor unit. 2 480,00 kr is 248000.',
    examples: [248000],
  }),
  currency: CurrencyCode,
}, {
  $id: 'MonetaryAmount',
  description:
    'An amount of money as an integer count of a currency\'s minor unit.',
});
export type MonetaryAmount = Static<typeof MonetaryAmount>;

/**
 * A calendar day, as `YYYY-MM-DD`.
 *
 * The one primitive this package has that `contracts-service-a` does not, and
 * the reason is the whole point of the distinction: an invoice falls due on a
 * **day** in the company's jurisdiction, not at an instant. Published as a
 * timestamp it would carry a time-of-day nobody chose and render as the
 * previous day for any reader east or west of whoever wrote it — a banner
 * saying the wrong date to half the users is worse than one that says nothing.
 *
 * `packages/db` draws the same line, and it is the only column in that schema
 * that does not reach TypeScript as a `Date`.
 *
 * The `pattern` sits beside `format: 'date'` rather than instead of it. The
 * format is the annotation a mock server generates from and a consumer's
 * codegen reads; the pattern is the part a validator that ignores formats
 * still enforces. Neither says the date exists — `2026-02-30` matches both,
 * and rejecting it is the provider's job rather than the schema's.
 */
export const CalendarDate = Type.String({
  description: 'A calendar day in the company\'s jurisdiction, as YYYY-MM-DD.',
  format: 'date',
  pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
  minLength: CALENDAR_DATE_LENGTH,
  maxLength: CALENDAR_DATE_LENGTH,
  examples: ['2026-09-20'],
});
export type CalendarDate = Static<typeof CalendarDate>;

/**
 * A company identifier, as it appears in this contract's path.
 *
 * The value is issued by `service-a` and echoed here, which is the shape of
 * the ownership graph in spec §1: `service-b` is a consumer of
 * `contracts-service-a` and a provider of this one, and a caller holding a
 * company id got it from the company selector. This package still declares its
 * own bound rather than importing `CompanyId` from `contracts-service-a`, for
 * the reason the header gives — two published surfaces that import each other
 * are two surfaces that version together.
 *
 * Opaque, with no `format: 'uuid'`: the column behind it is a `uuid` today and
 * publishing that would make migrating off it a contract change. The bound is
 * a statement about what the provider will read, not about what the value
 * looks like.
 *
 * No `$id`. `emitOpenApi` hoists on `$id`, and a component per string type puts
 * the constraint a reviewer is checking one indirection away from the field it
 * constrains. A path parameter could not reference a hoisted component anyway —
 * those are exploded into `parameters`.
 *
 * The example is the identifier `packages/db`'s seed inserts, so the Prism mock
 * and a running `service-b` answer the same request with the same id.
 */
export const CompanyId = Type.String({
  description: 'Opaque company identifier, as issued by service-a.',
  minLength: 1,
  maxLength: COMPANY_ID_MAX_LENGTH,
  examples: ['11111111-1111-4111-8111-111111111111'],
});
export type CompanyId = Static<typeof CompanyId>;
