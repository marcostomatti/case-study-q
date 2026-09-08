/**
 * Reads and the one write on `cards`: the card the mobile view renders, and
 * the state transition the `Activate card` action performs.
 *
 * ## Every lookup is scoped by company
 *
 * `findCardById` takes a company as well as a card, and `activateCard` does
 * too. The contract's path already carries both
 * (`/companies/:companyId/cards/:cardId/activation`) and this is the layer
 * that makes that scoping real rather than decorative: a card identifier
 * belonging to another company must answer `404`, and it can only do that if
 * the company reaches the `WHERE` clause. Filtering after the read would work
 * and is worse — the row has already left the database by then, and the next
 * person to add a caller has to remember the check.
 *
 * The contract folds "not yours to see" onto `not_found` on purpose (see
 * `contract.ts`), so a mis-scoped read returning `null` is exactly the right
 * shape: this layer cannot tell the two apart and must not.
 *
 * ## Why the activation write lives here
 *
 * It is the only write `service-a` performs on the mobile view's data, and it
 * is here rather than in `routes/` for the reason this directory exists at
 * all: this service reaches Postgres in one place. An `UPDATE ... RETURNING`
 * is a query that returns a Drizzle row like any other read below, and the
 * decision it encodes — *which* lifecycle states may be activated — is
 * provider vocabulary that belongs beside the table, not beside a transport.
 */
import type { ServiceDatabase } from './database';
import type { Card, CardLifecycleStatus } from '@marcos-corp/db';

import { cards } from '@marcos-corp/db';
import { and, asc, eq, inArray } from 'drizzle-orm';

/** A lookup by primary key, or of the one card this PoC gives a company. */
const ONE_ROW = 1;

/**
 * The lifecycle states a card may be activated **from**.
 *
 * Typed as the database's own union rather than as bare strings, so a member
 * renamed or dropped in `card_lifecycle_status` fails `bun run check-types`
 * here. Without the annotation a rename leaves this list matching nothing and
 * every activation answering "not activatable" — a wrong answer that no gate
 * in the verification order would report.
 *
 * The pair is the provider's issuing pipeline: `ordered` by the company and
 * `issued` by the processor both mean "the cardholder has not activated this
 * yet", which is precisely the pair `mapping/cardMapper.ts` folds onto the
 * contract's single `inactive`. A `frozen` card is not activated, it is
 * unfrozen, and a `terminated` one never comes back.
 */
export const ACTIVATABLE_LIFECYCLE_STATUSES: readonly CardLifecycleStatus[] = [
  'ordered',
  'issued',
];

/** What an activated card's `lifecycle_status` becomes. */
export const ACTIVATED_LIFECYCLE_STATUS: CardLifecycleStatus = 'active';

/** Addresses one card inside one company, which is the only way to address one. */
export interface CardLookup {
  readonly companyId: string;
  readonly cardId: string;
}

/** A card activation: which card, and the instant to stamp on it. */
export interface CardActivation extends CardLookup {
  /**
   * The instant written to `activated_at`.
   *
   * A parameter rather than `new Date()` inside, and rather than SQL's `now()`.
   * Same reason `packages/db`'s seed takes a `now`: a caller that fixes the
   * clock gets a reproducible row, and the service stamping the instant keeps
   * it on the same clock as the `api_usage` row for the request that caused it.
   */
  readonly activatedAt: Date;
}

/**
 * One card, scoped to its company. `null` when there is no such card, or when
 * there is one and it is not this company's.
 */
export async function findCardById(
  db: ServiceDatabase,
  lookup: CardLookup,
): Promise<Card | null> {
  const rows = await db
    .select()
    .from(cards)
    .where(and(
      eq(cards.id, lookup.cardId),
      eq(cards.companyId, lookup.companyId),
    ))
    .limit(ONE_ROW);

  return rows[0] ?? null;
}

/**
 * The card the dashboard renders for a company, or `null` when it has none.
 *
 * The mobile view shows one card and `Dashboard` publishes one card, so this
 * returns one. A company holding two is outside what the screen and the
 * contract can express today — publishing a second would need a card list in
 * the contract before it could need anything here — and the honest thing in
 * the meantime is a **fixed** choice rather than an unstable one.
 *
 * So the ordering is by identifier: arbitrary, and that is the point. It is
 * not a claim that the lowest id is the right card; it is a guarantee that a
 * company which acquires a second card keeps rendering the same one on every
 * request instead of flapping between them as the planner changes its mind.
 * Which card a multi-card company should see is a product decision, and it
 * gets made when the contract grows somewhere to put the answer.
 */
export async function findCompanyCard(
  db: ServiceDatabase,
  companyId: string,
): Promise<Card | null> {
  const rows = await db
    .select()
    .from(cards)
    .where(eq(cards.companyId, companyId))
    .orderBy(asc(cards.id))
    .limit(ONE_ROW);

  return rows[0] ?? null;
}

/**
 * Activates a card, and hands back the updated row.
 *
 * `null` means the update matched nothing, which covers three cases this layer
 * cannot and should not distinguish: no such card, a card belonging to another
 * company, and a card in a state that cannot be activated. A route that needs
 * to answer `404` for the first two and `409` for the third reads the card
 * first with `findCardById` and branches on what it finds.
 *
 * The state guard is nonetheless **in the `WHERE` clause** rather than left to
 * that prior read, and that is the load-bearing part of this function. Between
 * a route's read and its write another request can activate the same card, and
 * a blind `UPDATE ... SET lifecycle_status = 'active'` would overwrite the
 * first activation's `activated_at` and answer `200` to both callers. With the
 * guard the second one matches nothing and gets its `409`, which is what the
 * contract promises about a double-tap. No transaction and no row lock is
 * needed for it: a single `UPDATE` sees a consistent snapshot and re-checks
 * the predicate against the row it blocked on.
 */
export async function activateCard(
  db: ServiceDatabase,
  activation: CardActivation,
): Promise<Card | null> {
  const rows = await db
    .update(cards)
    .set({
      lifecycleStatus: ACTIVATED_LIFECYCLE_STATUS,
      activatedAt: activation.activatedAt,
    })
    .where(and(
      eq(cards.id, activation.cardId),
      eq(cards.companyId, activation.companyId),
      inArray(cards.lifecycleStatus, ACTIVATABLE_LIFECYCLE_STATUSES),
    ))
    .returning();

  return rows[0] ?? null;
}
