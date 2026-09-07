/**
 * The `api_usage` table: one row per request `service-a` answers, and the only
 * table in this schema that exists for the governance story rather than for
 * the mobile view.
 *
 * Spec §2.3 requires a `client_id` derived from credentials, logged alongside
 * the endpoint and the contract version, on every request. This is where that
 * log lands. It is required in the MVP with only three consumers because every
 * later capability reads from it and none of them can be added retroactively:
 * the affected-consumer list a major version needs (spec §6.2), the usage
 * query acceptance criterion §9.4 runs, and the "is anyone still calling this
 * field" check that gates field retirement (spec §6.4).
 *
 * **The naming rule the other five tables follow is inverted here, on
 * purpose.** `companies`, `cards`, `spend_limits`, `transactions` and
 * `invoices` all spell their columns unlike the contract's fields, because a
 * mapping layer is what keeps a column rename from being a breaking change
 * (spec §2.1). This table publishes nothing and no contract describes it — a
 * row is a fact *about* a contract, not a payload derived from one. So
 * `client_id`, `operation_id` and `contract_version` are spelled exactly as
 * the governance vocabulary spells them, because their entire value is joining
 * a recorded call back to a published operation and a published version. A
 * "consistent" rename here would break the join and cost the divergence
 * nothing, since there is no contract on the other side to diverge from.
 *
 * Three decisions a reader has to have before querying or writing this table:
 *
 *   - **`client_id` is authoritative; `consumer_package_name` is not.** The
 *     first is derived from the credential the request presented and is what
 *     spec §6.3 issues with a named owner. The second is what the calling code
 *     said about itself, and a consumer can say anything. Keeping both is
 *     deliberate: when they disagree — a `client_id` issued to `web-b` arriving
 *     with `@marcos-corp/service-b`'s name — that is a credential that has been
 *     copied, and it is visible in one query. Notification under spec §6.4 goes
 *     to the owner of the `client_id`, never to whoever the payload claimed.
 *   - **There are no foreign keys, and that is not an oversight.** Every other
 *     child table here references its parent, so a table with none reads as one
 *     somebody forgot. A `client_id` is not a row in this database (issuance is
 *     manual, per spec §6.3 and `docs/governance.md`), an `operation_id`
 *     belongs to a document in `packages/contracts-service-a/openapi/`, and a
 *     `contract_version` names a package version. More importantly, a telemetry
 *     row records what happened and must survive whatever happens to the rows
 *     it describes — a `RESTRICT` here would let a log entry block an
 *     operational delete, and a `CASCADE` would erase the evidence.
 *   - **Retention is not implemented.** Spec §6.4 asks for at least 13 months
 *     of rollups, because a quarterly or annual consumer is invisible in a
 *     30-day window. This table is raw rows with no partitioning, no rollup and
 *     no expiry job; the requirement is recorded in `docs/field-retirement.md`
 *     as something the design answers and the PoC does not implement. Nothing
 *     below silently satisfies it.
 */
import { bigserial, index, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';

export const apiUsage = pgTable('api_usage', {
  // `bigserial`, not the `uuid` every other table in this schema uses. Nothing
  // dereferences an api_usage row — no contract publishes it and no table
  // references it — so a random UUID buys no addressability and costs a random
  // insertion point in the primary key on the highest-write table here. A
  // monotonic key keeps that index append-only, which is the access pattern.
  //
  // `mode: 'number'` is invisible to `getSQLType()` (both modes render
  // `bigserial`), so `apiUsage.test-d.ts` is the only gate that fails when it
  // changes. Same trap as `invoices.due_on`.
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  // When the request completed, recorded by the service rather than defaulted
  // to `now()` by the database. Deliberate: a `DEFAULT now()` records the
  // *insert* instant, which drifts from the request under any batched or
  // retried write, and the 30-day and 13-month windows are read off this
  // column. A logger that forgets to set it fails loudly instead.
  occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
  // Spec §2.3's consumer identity, derived from credentials. Never
  // `User-Agent`. Free text rather than a constrained type because issuance is
  // manual with a named owner (spec §6.3) and the format is the issuer's.
  clientId: text('client_id').notNull(),
  // The emitted document's `operationId`, which `@marcos-corp/contract-tooling`
  // derives from the ts-rest router keys (`{ cards: { activate } }` becomes
  // `cardsActivate`). Storing that id rather than a method-and-path pair is
  // what makes usage joinable to the contract: a path can be rewritten in a
  // non-breaking way, an `operationId` cannot.
  operationId: text('operation_id').notNull(),
  // The contract package version the request was served under, exactly as the
  // consumer pinned it (spec §2.2) — `0.1.0`, never a range. This is the column
  // that turns "who calls this" into "who calls this on which version", which
  // is the question a major version has to answer (spec §6.2).
  contractVersion: text('contract_version').notNull(),
  // The HTTP status code. `smallint` because the domain is three digits, and
  // suffixed `_code` for the reason `pan_last_four` is prefixed `pan_`: so a
  // reader cannot mistake it for a state enum. An error response is logged
  // exactly like a success — a consumer failing against a version is usage.
  responseStatusCode: smallint('response_status_code').notNull(),
  // What the caller said it was: `@marcos-corp/web-b`, `@marcos-corp/service-b`.
  // Self-reported and therefore a debugging aid, not an identity. See the
  // header for why it is kept next to a `client_id` that cannot be spoofed.
  consumerPackageName: text('consumer_package_name').notNull(),
}, (table) => [
  // The field-retirement read (spec §6.4): every call a given consumer made to
  // a given operation, bounded by time. `client_id` leads because that query
  // starts from a consumer; `occurred_at` follows because a retirement question
  // is always asked over a window, never over all history.
  index('api_usage_client_id_occurred_at_idx').on(table.clientId, table.occurredAt),
  // The usage-query read (spec §9.4): every consumer, every operation, every
  // version, over the last 30 days. That one starts from the window and filters
  // no client, so the composite above cannot serve it — a btree is only usable
  // from its leading column.
  //
  // Both indexes are ascending even though the reads sort newest first, for the
  // reason spelled out at length in `transactions.ts`: drizzle renders `.desc()`
  // as `DESC NULLS LAST`, the planner matches a pathkey literally, and such an
  // index is then unusable by a plain `ORDER BY occurred_at DESC`.
  index('api_usage_occurred_at_idx').on(table.occurredAt),
]);

/**
 * One recorded call, as it comes back from a query.
 *
 * Named for the event rather than for the table — `ApiUsage` would read as an
 * aggregate, and a row is a single request. The one place this schema departs
 * from naming a row type after the singular of its table.
 */
export type ApiUsageEvent = typeof apiUsage.$inferSelect;

/** A call as it goes in. `id` is optional: the database generates it. */
export type NewApiUsageEvent = typeof apiUsage.$inferInsert;
