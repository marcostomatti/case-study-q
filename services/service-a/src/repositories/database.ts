/**
 * The database handle every function under `repositories/` takes, and the one
 * place in this service that names a driver.
 *
 * ## Why this is a Drizzle type and not a port
 *
 * `telemetry/usageLogger.ts` states its database need as a one-method
 * `UsageDatabase` interface, and says in its own header that it does so partly
 * to avoid tying itself to "the connection strategy
 * `services/service-a/src/repositories/` gets to choose". This is that choice,
 * and it goes the other way on purpose.
 *
 * The usage logger hands over six values through one `INSERT`; a port for that
 * is two lines and keeps a driver out of the exported surface of a module
 * whose job has nothing to do with databases. A repository issues `SELECT`s
 * with predicates, ordering, limits, offsets and an `UPDATE ... RETURNING`.
 * Writing a structural interface wide enough to admit those is writing a
 * second, worse copy of Drizzle's query builder — one that agrees with
 * whatever fake a suite hands it and with nothing else, which is the failure
 * mode `usageLogger.test-d.ts` exists to rule out for the narrow case. This
 * layer's entire job *is* talking to the database, so the driver belongs in
 * its signature and the suites beside it run against a real Postgres.
 *
 * ## What the type parameter says
 *
 * `NodePgDatabase`'s schema parameter defaults to `Record<string, never>`,
 * which is the handle `drizzle({ client: pool })` returns when no `schema` is
 * passed. That is deliberate: the relational query API (`db.query.<table>`)
 * needs a schema-bearing handle, and this layer does not use it. Every read
 * below is an explicit `select().from(table)`, so the tables reach a query as
 * values rather than through a handle that has to be constructed knowing about
 * them — which is what lets `server.ts`, the suites here and
 * `packages/db`'s own throwaway server all hand over the same shape.
 *
 * `pg` is deliberately imported by nothing under `repositories/`. Nothing here
 * opens a connection: a handle arrives as a parameter, exactly as
 * `apiUsageSink` takes one and `loadServiceEnv` is a function rather than a
 * parsed singleton, so importing this service still works on a machine with no
 * database. The one module that builds a pool is `server.ts`, through
 * `openServiceDatabase`, which is the only reason `pg` is a dependency of this
 * package at all.
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * A connected Drizzle handle on the `@marcos-corp/db` schema.
 *
 * Accepted rather than created. `server.ts` builds one from
 * `loadServiceEnv().databaseUrl` and passes it down; a suite passes one from
 * `@marcos-corp/db/testing`. Both are the same type, which is what makes the
 * suites evidence about the production path rather than about a stub.
 */
export type ServiceDatabase = NodePgDatabase;
