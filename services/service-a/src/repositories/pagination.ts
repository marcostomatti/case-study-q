/**
 * The page a list repository is asked for, and the page it hands back.
 *
 * ## Why the bounds are re-checked here
 *
 * The contract already states them: `PaginationQuery` caps `limit` at
 * `PAGE_LIMIT_MAX` and floors `offset` at zero, and the ts-rest router
 * validates a request against that schema before any route body runs. So this
 * is a second check of something already checked, and it is here on purpose —
 * this is the last layer before SQL, and an unbounded `LIMIT` reaching
 * Postgres is the failure the contract's ceiling exists to prevent. A guard
 * that only holds while every caller goes through the router is a guard that
 * stops holding the first time something does not: a repository called from
 * `scripts/`, from an acceptance script, or from a second transport nobody has
 * written yet.
 *
 * The bounds themselves are **imported from the contract rather than restated**
 * (`PAGE_LIMIT_MIN` / `PAGE_LIMIT_MAX`). Two copies of a number that must agree
 * is how they stop agreeing, and the published ceiling is the one a consumer
 * read out of the document — raising it is a contract change that should move
 * the provider's guard with it, in one edit.
 *
 * Zod is the tool here, per this repo's split: TypeBox authors what
 * `packages/contracts-*` publishes, Zod validates everything internal — the
 * environment, post-parse coercion, and repository-layer shapes like this one.
 * Nothing in this file is ever published.
 *
 * ## What is deliberately not bounded
 *
 * `offset` has a floor and no ceiling. A large offset is a slow query, and
 * capping it here would reject a request the published contract says is legal —
 * `PageInfo.offset` states `minimum: 0` and no maximum, and a provider that
 * refuses inside the contract's stated range is a provider whose document is
 * wrong. If deep paging ever needs a bound, the bound belongs in the contract
 * first, which is spec section 6.1's additive path.
 */
import { PAGE_LIMIT_MAX, PAGE_LIMIT_MIN } from '@marcos-corp/contracts-service-a';
import { z } from 'zod';

/** Offsets count items already skipped, so the floor is zero. */
const MIN_OFFSET = 0;

/** What a caller asks a list repository for. Both parts are required here. */
export interface PageRequest {
  /** How many rows to return. Bounded by the contract's published ceiling. */
  readonly limit: number;
  /** How many rows to skip first. */
  readonly offset: number;
}

/**
 * One page of rows, plus how many there are in total.
 *
 * `total` counts every row matching the same predicate, not the rows on this
 * page. It is what the contract's `PageInfo.total` publishes and what the
 * dashboard's `54 more items` is derived from, so a repository that returned
 * only the page would leave both figures uncomputable.
 */
export interface Page<Row> {
  readonly items: readonly Row[];
  readonly total: number;
}

/**
 * A page request, as the last layer before SQL will accept it.
 *
 * Strict, so a caller that misspells a field is told rather than silently
 * paged with a default it did not ask for. Note that this is not the same
 * claim `requestObject` makes in the contract: this schema is handed a typed
 * object built in-process, so strictness is a guard against an untyped caller
 * rather than against a consumer.
 */
export const pageRequestSchema = z.strictObject({
  limit: z
    .number()
    .int('must be a whole number of rows')
    .min(PAGE_LIMIT_MIN, `must be at least ${PAGE_LIMIT_MIN}`)
    .max(PAGE_LIMIT_MAX, `must be at most ${PAGE_LIMIT_MAX}, the contract's published ceiling`),
  offset: z
    .number()
    .int('must be a whole number of rows')
    .min(MIN_OFFSET, `must be at least ${MIN_OFFSET}`),
});

/**
 * Thrown when a page request cannot reach the database.
 *
 * A distinct class rather than a bare `Error`, so `routes/` can answer the
 * contract's `400` for this and let anything else become a `500`. The message
 * names each offending field and what it must be, in the same
 * `<field> is <value>, which must be ...` shape `EnvironmentError` uses.
 */
export class PageRequestError extends Error {
  /** One entry per field the schema rejected, in schema-key order. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`page request is unusable: ${problems.join('; ')}`);
    this.name = 'PageRequestError';
    this.problems = problems;
  }
}

/**
 * The single row an ungrouped `count(*)` returns.
 *
 * Postgres cannot answer an aggregate with no `GROUP BY` with zero rows, so
 * the absent case is unreachable — and it throws rather than falling back to
 * `0` for exactly that reason. A default there would turn "the query did
 * something this code does not understand" into "there are no rows", which is
 * a plausible-looking figure the dashboard would render as `0 more items`.
 */
export function readTotal(rows: readonly { readonly total: number }[]): number {
  const first = rows[0];
  if (first === undefined) {
    throw new Error('a count query returned no row, which an ungrouped aggregate cannot do');
  }
  return first.total;
}

/**
 * One rejected field as a sentence.
 *
 * A strict object reports an unrecognised key with an empty `path` — the
 * complaint is about the object, not about one of its fields — so prefixing
 * unconditionally would emit a leading space and a sentence starting nowhere.
 */
function describeIssue(issue: { path: PropertyKey[]; message: string }): string {
  const field = issue.path.join('.');
  return field === ''
    ? issue.message
    : `${field} ${issue.message}`;
}

/**
 * Refuses a page request that must not reach SQL, and returns it otherwise.
 *
 * Returns the parsed value rather than `void` so a caller cannot forget to use
 * the checked one — the same reason `loadServiceEnv` hands back settings
 * instead of validating in place.
 */
export function assertPageRequest(page: PageRequest): PageRequest {
  const parsed = pageRequestSchema.safeParse(page);
  if (parsed.success) {
    return parsed.data;
  }

  throw new PageRequestError(parsed.error.issues.map(describeIssue));
}
