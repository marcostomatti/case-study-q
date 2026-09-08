/**
 * A Drizzle `cards` row, translated into the `Card` the contract publishes.
 *
 * This module is the concrete answer to spec section 2.1. A schema derived
 * from the `cards` table would publish `lifecycle_status`, `pan_last_four`,
 * `art_asset_key` and a nullable `activated_at`, and every one of those would
 * become a fact consumers depend on. Translating instead costs the twenty
 * lines below and buys four things a derived schema cannot have:
 *
 * - **A column rename stops being a breaking change.** `lifecycle_status` is
 *   deliberately not spelled `state`, and this file is the only place that
 *   knows the two are the same thing. Renaming the column is a migration the
 *   provider owns; renaming the contract's field is spec section 6.2's
 *   major-version procedure. Keeping them apart is what stops the second from
 *   being mistaken for the first.
 * - **A database enum can grow a member without a coordinated deploy.** The
 *   database's five states fold onto the contract's four, and anything this
 *   file does not recognise folds onto `unknown` (spec section 2.5). Adding
 *   `suspended` to `card_lifecycle_status` is then a provider-side change that
 *   an already-pinned consumer survives, rather than a payload it validated a
 *   moment ago and now throws on.
 * - **A nullable column does not publish a `null`.** `activated_at` is null
 *   until the cardholder activates. Spec section 2.5 says `null` is never
 *   emitted and absent means not applicable, so an unactivated card omits the
 *   field entirely — the key is not present, not present-and-undefined.
 * - **An opaque storage key does not become a consumer dependency.**
 *   `art_asset_key` names the artwork; the contract publishes a URL that can
 *   be fetched. Resolving one into the other is the provider's business, which
 *   is what the column's own note in `packages/db` promises, and moving the
 *   assets to a different host stays a deployment change.
 *
 * ## The fold is deliberately lossy, and only in the safe direction
 *
 * `ordered` and `issued` are the provider's issuing pipeline and both mean
 * "the cardholder has not activated this yet", which is the only thing a
 * consumer branches on. `terminated` is published as `closed` because that is
 * the cardholder's word for it. Nothing here invents a state the database
 * cannot be in, and no consumer can reconstruct the pipeline from the result —
 * which is the point.
 *
 * `CARD_STATE_BY_LIFECYCLE_STATUS` is typed as a total record over the
 * database's enum, so a member added to `card_lifecycle_status` without a
 * decision taken here fails `bun run check-types` rather than silently
 * reaching consumers as `unknown`. The `unknown` fallback exists for a value
 * this build has never heard of — a database migrated ahead of the running
 * service — not as a licence to skip the decision.
 *
 * ## Where the art base URL comes from
 *
 * It is a parameter, never an environment read, for the reason
 * `buildConsumerRegistry` and `loadServiceEnv` both give: importing this
 * module must not require a configured machine. `server.ts` supplies it when
 * it builds the router. `config/env.ts` declares three variables today and
 * growing a fourth is that module's decision, with its own closure cases —
 * this file states what it needs and leaves that call where it belongs.
 */
import type { Card as ContractCard, CardState } from '@marcos-corp/contracts-service-a';
import type { Card as CardRow, CardLifecycleStatus } from '@marcos-corp/db';

/**
 * What an unrecognised database value becomes (spec section 2.5).
 *
 * Named rather than written at each fold, because it is the same governance
 * decision in three places and reads as a magic string in all of them.
 */
const UNKNOWN_CARD_STATE: CardState = 'unknown';

/**
 * The file extension the asset store serves card artwork under.
 *
 * The stored key names the artwork and not the file, so the format is the
 * provider's to change — a one-line change here rather than a migration over
 * every row. The contract publishes only the resolved URL, so no consumer can
 * tell the difference either way.
 */
const CARD_ART_EXTENSION = '.png';

/** An absolute `http`/`https` URL. Anything relative cannot be published. */
const ABSOLUTE_HTTP_URL = /^https?:\/\/\S+$/i;

/** Leading separators on a stored key, so joining never doubles a slash. */
const LEADING_SLASHES = /^\/+/;

/**
 * The contract state each database state folds onto.
 *
 * Total over `CardLifecycleStatus` on purpose: this is the type-level half of
 * the argument above, and it is the only thing that turns "somebody added an
 * enum member" into a failed build instead of a quiet `unknown`.
 */
const CARD_STATE_BY_LIFECYCLE_STATUS: Readonly<Record<CardLifecycleStatus, CardState>> = {
  // Ordered by the company, not yet issued by the processor. A consumer sees
  // the same thing either way: a card that cannot be used yet.
  ordered: 'inactive',
  // Issued but not activated — the state the screen's `Activate card` button
  // exists for, and the state `packages/db`'s seed leaves the demo card in.
  issued: 'inactive',
  active: 'active',
  frozen: 'frozen',
  // The cardholder's word for it. `terminated` is the processor's.
  terminated: 'closed',
};

/**
 * The same table as a `Map`, which is what makes the fold cast-free.
 *
 * The record above is keyed on the database's union, so indexing it with an
 * arbitrary string needs a cast that would also silence a genuinely wrong key.
 * A `Map<string, CardState>` states exactly what the lookup is: a value that
 * may or may not be one this build knows.
 */
const CARD_STATE_LOOKUP = new Map<string, CardState>(
  Object.entries(CARD_STATE_BY_LIFECYCLE_STATUS),
);

/**
 * Folds a database card state onto the contract's.
 *
 * Takes a `string` rather than `CardLifecycleStatus` deliberately. The row
 * type says the column holds one of five values and the running database is
 * free to disagree — a service deployed against a schema that has moved on
 * receives a sixth, and the whole point of spec section 2.5's `unknown` member
 * is that such a value is answered rather than thrown on.
 */
export function toContractCardState(lifecycleStatus: string): CardState {
  return CARD_STATE_LOOKUP.get(lifecycleStatus) ?? UNKNOWN_CARD_STATE;
}

/**
 * Turns a stored asset key into the absolute URL the contract publishes.
 *
 * A plain join rather than `new URL(key, base)`: the two-argument form
 * replaces the base's last path segment when the base has no trailing slash,
 * and lets an absolute-looking key override the host entirely. Neither is a
 * surprise anyone wants from a value read out of a table.
 *
 * A base that is not an absolute URL is a misconfiguration, and it throws for
 * the reason `buildConsumerRegistry` throws: the alternative is publishing a
 * relative string in a field the contract says is an absolute URL, which every
 * consumer then resolves against its own origin. Reaching this with a bad base
 * means `server.ts` was wired wrong, and Express turns the throw into a `500`.
 */
export function resolveCardArtUrl(artAssetKey: string, artBaseUrl: string): string {
  if (!ABSOLUTE_HTTP_URL.test(artBaseUrl)) {
    throw new Error(
      'card art base URL must be an absolute http or https URL, but service-a '
      + `was configured with '${artBaseUrl}'`,
    );
  }

  const base = artBaseUrl.endsWith('/')
    ? artBaseUrl
    : `${artBaseUrl}/`;

  return `${base}${artAssetKey.replace(LEADING_SLASHES, '')}${CARD_ART_EXTENSION}`;
}

/** What `toContractCard` needs beyond the row itself. */
export interface CardMappingOptions {
  /**
   * Where card artwork is served from, as an absolute URL. Supplied by
   * `server.ts`; see the module header for why it is not read from the
   * environment here.
   */
  readonly artBaseUrl: string;
}

/**
 * A `cards` row as the contract publishes it.
 *
 * `activatedAt` is spread in conditionally rather than assigned `undefined`,
 * so an unactivated card produces an object with no such key at all. The two
 * are indistinguishable after `JSON.stringify` and are not indistinguishable
 * to a test — `toStrictEqual` and an `in` check both see the difference, and
 * the colocated suite makes that claim rather than trusting the serialiser.
 */
export function toContractCard(row: CardRow, options: CardMappingOptions): ContractCard {
  return {
    id: row.id,
    lastFour: row.panLastFour,
    state: toContractCardState(row.lifecycleStatus),
    artUrl: resolveCardArtUrl(row.artAssetKey, options.artBaseUrl),
    ...row.activatedAt === null
      ? {}
      : { activatedAt: row.activatedAt.toISOString() },
  };
}
