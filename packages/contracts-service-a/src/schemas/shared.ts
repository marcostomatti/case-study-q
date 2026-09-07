/**
 * The primitives every operation in this contract reuses: a monetary amount, an
 * instant, the pagination envelope, and the two object builders that carry spec
 * §2.5's request/response asymmetry.
 *
 * Everything here is hand-authored TypeBox and derived from nothing. It is in
 * particular not derived from `@marcos-corp/db` (spec §2.1), which this package
 * must not depend on: the tables behind this contract store money as two flat
 * columns and this module publishes one object, and that divergence is exactly
 * what the mapping layer in `services/service-a` exists to translate. A column
 * rename there stops being a contract break because of it.
 *
 * ## The conventions this module encodes
 *
 * - **Money is an integer minor-unit value paired with an ISO-4217 code.** The
 *   `5 400 kr` the mobile view renders is `{ minorUnits: 540000, currency:
 *   'SEK' }`. Never a float — binary rounding loses cents — and never a
 *   preformatted string, which moves the provider's locale into every consumer
 *   and makes the figure unusable for arithmetic.
 * - **An instant is an ISO-8601 string**, never an epoch number. A number
 *   states neither its offset nor its precision, and both have to be guessed
 *   by every consumer separately.
 * - **A list response is an envelope**, `{ items, page }`. A bare array leaves
 *   nowhere to put the total, so adding one later is a new response shape
 *   rather than an additive field.
 * - **`additionalProperties` is decided by direction, not per call site.**
 *   Requests reject unknown fields; responses tolerate them (spec §2.5). The
 *   two builders below set it, and `ContractObjectOptions` makes overriding it
 *   a `check-types` failure. House rule 2 requires the key to be present on
 *   every object schema — these builders are what make it present by
 *   construction rather than by everyone remembering.
 *
 * ## Why some schemas carry `$id` and others do not
 *
 * `emitOpenApi` hoists any schema carrying `$id` into `components.schemas` and
 * leaves a `$ref` in its place. Objects reused across operations carry one, so
 * the emitted document names the shape once and an edit to it reads as a single
 * change in the diff gate rather than one per usage. The scalars here do not: a
 * component per string type pushes the constraint a reviewer is checking one
 * indirection away from the field it constrains, and buys nothing back.
 *
 * `null` appears in neither kind. Absent means not applicable — one convention,
 * applied everywhere, with house rule 6 rejecting both spellings of the other
 * one.
 */
import type {
  Static,
  TArray,
  TObject,
  TProperties,
  TSchema,
} from '@sinclair/typebox';

import { Type } from '@sinclair/typebox';

/**
 * The object options a contract author may set.
 *
 * `additionalProperties` is deliberately not among them. Which way it goes is a
 * property of the direction the payload travels rather than of the individual
 * schema, so it belongs to the builder that knows the direction; a call site
 * that could override it is a call site where spec §2.5 can be reversed by
 * accident and still lint clean.
 *
 * Spelled out as its own interface rather than as
 * `Omit<ObjectOptions, 'additionalProperties'>`, which looks like the same
 * thing and states nothing: TypeBox's `SchemaOptions` carries an
 * `[prop: string]: any` index signature, so `Omit` drops every named member,
 * keeps the index signature, and hands the key straight back. The allow-list
 * below is the only form of this that a compiler enforces — measured, with the
 * `@ts-expect-error` case in `shared.test-d.ts` as the control.
 *
 * `deprecated` and `x-sunset` travel together on purpose: house rule 4 fails
 * anything marked deprecated without a date, which is what makes the field
 * retirement flow in spec §6.4 possible at all.
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
 * This is the schema half of spec §2.5's "consumers ignore unknown response
 * fields". The provider deploys before the consumer adopts, so a consumer
 * validating a payload against its own pinned version routinely sees fields
 * that version predates. `additionalProperties: false` here would turn every
 * additive change — the one kind the diff gate lets through unreviewed — into a
 * runtime failure for exactly the consumers who did nothing wrong.
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
 * The other half of spec §2.5, and the reason the asymmetry is safe here:
 * provider-first deploy ordering means the provider already accepts a field
 * before any consumer sends it, so strictness costs nothing and a misspelled
 * field is reported rather than silently ignored.
 *
 * For a query or a path-parameter container the emitted document never carries
 * this object — `emitOpenApi` explodes those into `parameters`, so the
 * strictness becomes the service's own to enforce. The schema still states it,
 * because it is what the ts-rest server validates against.
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

/** Counts and offsets start at zero. */
const NON_NEGATIVE_MINIMUM = 0;

/** Smallest page a consumer may ask for. Zero would be a request for nothing. */
export const PAGE_LIMIT_MIN = 1;

/**
 * Largest page a consumer may ask for. A ceiling in the contract is what stops
 * an unbounded query reaching the database, and stating it here means a
 * consumer learns the bound from the document rather than from a rejection.
 */
export const PAGE_LIMIT_MAX = 100;

/** What a consumer gets when it asks for no particular page size. */
export const PAGE_LIMIT_DEFAULT = 20;

/**
 * The currency a monetary amount is denominated in: an ISO-4217 alphabetic
 * code, uppercase.
 *
 * Deliberately not an enum. House rule 3 would then require an `unknown`
 * member, which for a published external standard is noise — ISO-4217 is not
 * this provider's vocabulary to extend, and a consumer receiving a code it does
 * not recognise has a currency, not an unknown state. The pattern is what makes
 * the constraint machine-readable; the standard is what makes it meaningful.
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
 * `minorUnits` is **signed**. A refund and a reversal are negative, and a
 * schema that forbade them would push the sign into a second field or into a
 * transaction type, which is how a total ends up computed with the wrong one.
 *
 * No upper bound is stated on purpose. The column behind this today is a
 * 32-bit `integer`, and widening it is a provider-side migration no consumer
 * can see — stating the column's ceiling here would publish an implementation
 * detail and make that migration a contract change.
 */
export const MonetaryAmount = responseObject({
  minorUnits: Type.Integer({
    description:
      'Signed amount in the currency\'s minor unit. 5 400 kr is 540000.',
    examples: [540000],
  }),
  currency: CurrencyCode,
}, {
  $id: 'MonetaryAmount',
  description:
    'An amount of money as an integer count of a currency\'s minor unit.',
});
export type MonetaryAmount = Static<typeof MonetaryAmount>;

/**
 * An instant, as an ISO-8601 / RFC-3339 timestamp string.
 *
 * `format: 'date-time'` is an annotation rather than a constraint a validator
 * is obliged to enforce, which is the honest state of affairs: the provider
 * enforces the shape, and the annotation is what a mock server generates from
 * and a consumer's codegen reads. A hand-written regex in its place would be
 * long, subtly wrong about leap seconds and offsets, and understood by nothing.
 *
 * A calendar day is not this type. A day has no instant, and rendering one as
 * an instant reports the previous day for a reader in another zone — the
 * distinction `packages/db` already draws between `booked_at` and `due_on`.
 */
export const Timestamp = Type.String({
  description: 'An instant, ISO-8601 with an explicit offset.',
  format: 'date-time',
  examples: ['2026-09-08T07:41:00Z'],
});
export type Timestamp = Static<typeof Timestamp>;

/**
 * Where a page sits in the collection it was taken from.
 *
 * Offset paging rather than a cursor, because the screen this contract serves
 * offers a transaction list a reader scrolls and a count of what is left over
 * (`54 more items`), and `total` is what produces that count. A cursor would be
 * the right answer for a feed that mutates under the reader; it is not what
 * this screen asks for, and adding one later is an additive field on this
 * object rather than a new response shape.
 *
 * There is no `hasMore`: it is `offset + items.length < total`, and a stored
 * copy of a derived value is a second source of truth that can disagree.
 */
export const PageInfo = responseObject({
  limit: Type.Integer({
    description: 'Page size the provider applied, which may be the default.',
    minimum: PAGE_LIMIT_MIN,
    maximum: PAGE_LIMIT_MAX,
    examples: [PAGE_LIMIT_DEFAULT],
  }),
  offset: Type.Integer({
    description: 'Number of items skipped before this page.',
    minimum: NON_NEGATIVE_MINIMUM,
    examples: [NON_NEGATIVE_MINIMUM],
  }),
  total: Type.Integer({
    description: 'Total items matching the query, across every page.',
    minimum: NON_NEGATIVE_MINIMUM,
    examples: [57],
  }),
}, {
  $id: 'PageInfo',
  description: 'Where a page sits in the collection it was taken from.',
});
export type PageInfo = Static<typeof PageInfo>;

/**
 * The envelope every list response in this contract is served in: the items,
 * and where they sit.
 *
 * A function rather than a schema because JSON Schema has no generics — each
 * operation's list is its own shape and its own component. Pass an `$id` in
 * `options` to have `emitOpenApi` hoist that shape into `components.schemas`;
 * omit it and the envelope is inlined at the operation.
 */
export function paginatedResponse<Item extends TSchema>(
  items: Item,
  options: ContractObjectOptions = {},
): TObject<{ items: TArray<Item>; page: typeof PageInfo }> {
  return responseObject({
    items: Type.Array(items, { description: 'The items on this page.' }),
    page: PageInfo,
  }, options);
}

/**
 * The query parameters every paginated operation accepts.
 *
 * Both are optional, and each states its default in the document so a consumer
 * can read what it gets by omitting them rather than discovering it from a
 * response. Absent means "use the default" — which is the same convention as
 * everywhere else here, since a default is precisely what "not applicable to
 * this caller" resolves to.
 *
 * No `$id`: `emitOpenApi` explodes a query container into `parameters`, so a
 * hoisted component here would be a schema nothing references.
 */
export const PaginationQuery = requestObject({
  limit: Type.Optional(Type.Integer({
    description: 'Page size to return.',
    minimum: PAGE_LIMIT_MIN,
    maximum: PAGE_LIMIT_MAX,
    default: PAGE_LIMIT_DEFAULT,
  })),
  offset: Type.Optional(Type.Integer({
    description: 'Number of items to skip before the page.',
    minimum: NON_NEGATIVE_MINIMUM,
    default: NON_NEGATIVE_MINIMUM,
  })),
}, { description: 'Offset paging parameters.' });
export type PaginationQuery = Static<typeof PaginationQuery>;
