import { describe, expect, it } from 'vitest';

import {
  columnFacts,
  foreignKeyFacts,
  indexFacts,
  primaryKeyFacts,
  sqlTableName,
} from '../testing/tableFacts';

import { apiUsage } from './apiUsage';

/**
 * The governance vocabulary this table has to spell exactly, written out here
 * rather than imported. `packages/contracts-service-a` does not exist yet, and
 * once it does this package must not import it — but unlike every other table
 * in this schema, the claim here is that the two vocabularies **agree**, so a
 * literal is what the assertion needs.
 */
const GOVERNANCE_COLUMNS = ['client_id', 'operation_id', 'contract_version'] as const;

/**
 * What this file pins that `apiUsage.test-d.ts` cannot: the SQL names, the
 * rendered types, the absence of every foreign key, and both indexes with
 * their column order — none of which reach any inferred type, and the last two
 * of which are invisible to every gate in the verification order.
 *
 * The reverse split bites here the same way it does for `invoices.due_on`:
 * `bigserial` renders identically under `mode: 'number'` and `mode: 'bigint'`,
 * so nothing in this file can tell a `number` id from a `bigint` one. That
 * claim is `apiUsage.test-d.ts`'s alone.
 */
describe('api_usage table', () => {
  it('reaches SQL as `api_usage`', () => {
    expect(sqlTableName(apiUsage)).toBe('api_usage');
  });

  it('records the six facts spec §2.3 needs, under a monotonic key', () => {
    expect(columnFacts(apiUsage)).toEqual({
      id: {
        // `bigserial`, not the `uuid` every other table here uses. Nothing
        // dereferences one of these rows, and a monotonic key keeps the
        // primary index append-only on the highest-write table in the schema.
        sqlName: 'id',
        sqlType: 'bigserial',
        notNull: true,
        hasDefault: true,
        isPrimaryKey: true,
        isUnique: false,
      },
      occurredAt: {
        sqlName: 'occurred_at',
        sqlType: 'timestamp with time zone',
        notNull: true,
        // No `DEFAULT now()`: the service records when the request completed,
        // not when the row happened to be inserted. See the module header.
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      clientId: {
        sqlName: 'client_id',
        sqlType: 'text',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      operationId: {
        sqlName: 'operation_id',
        sqlType: 'text',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      contractVersion: {
        sqlName: 'contract_version',
        sqlType: 'text',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      responseStatusCode: {
        // `smallint`, not the `integer` the money columns use: an HTTP status
        // is three digits, and the minor-unit ceiling argument does not apply.
        sqlName: 'response_status_code',
        sqlType: 'smallint',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
      consumerPackageName: {
        sqlName: 'consumer_package_name',
        sqlType: 'text',
        notNull: true,
        hasDefault: false,
        isPrimaryKey: false,
        isUnique: false,
      },
    });
  });

  it('spells the governance columns exactly as the contract vocabulary does', () => {
    // The inversion of every other suite in this directory, which assert that
    // no column is named the way the contract names its field. This table
    // publishes nothing and describes a contract rather than deriving from
    // one, so the join back to a published `operationId` and a pinned version
    // is the whole value — and a rename for "consistency" with its siblings
    // would break that join and buy nothing.
    const sqlNames = Object.values(columnFacts(apiUsage)).map((facts) => facts.sqlName);

    GOVERNANCE_COLUMNS.forEach((expected) => {
      expect(sqlNames).toContain(expected);
    });
  });

  it('keeps the credential-derived identity and the self-reported name apart', () => {
    // Both, deliberately: `client_id` is issued with a named owner and cannot
    // be chosen by the caller, `consumer_package_name` is whatever the calling
    // code said. Collapsing them into one column — the tempting simplification,
    // since they agree on every honest request — is what would make a copied
    // credential invisible. Spec §6.4 notifies the owner of the first.
    const sqlNames = Object.values(columnFacts(apiUsage)).map((facts) => facts.sqlName);

    expect(sqlNames).toContain('client_id');
    expect(sqlNames).toContain('consumer_package_name');
  });

  it('stores no derived usage figure, only the raw calls', () => {
    // Same argument as `spend_limits` storing no `remaining` and `invoices`
    // storing no `overdue`: a count or a rollup is a second source of truth
    // with nothing to recompute it. Spec §6.4's 13-month rollup requirement is
    // recorded in `docs/field-retirement.md` as unimplemented, and this case is
    // what stops it being half-implemented as a column here instead.
    const sqlNames = Object.values(columnFacts(apiUsage)).map((facts) => facts.sqlName);

    expect(sqlNames).not.toContain('call_count');
    expect(sqlNames).not.toContain('request_count');
    expect(sqlNames).not.toContain('last_called_at');
  });

  it('declares no foreign key at all, unlike every other child table here', () => {
    // Not an oversight, which is exactly how an empty list reads next to five
    // tables that all reference their parent. A `client_id` is not a row in
    // this database, and a telemetry row must outlive whatever it describes: a
    // RESTRICT would let a log entry block an operational delete and a CASCADE
    // would erase the evidence. See the module header.
    expect(foreignKeyFacts(apiUsage)).toEqual([]);
  });

  it('keys on the surrogate column rather than on a composite', () => {
    // A composite natural key would be wrong here, and the mistake is easy to
    // make: the same client legitimately calls the same operation at the same
    // version many times, so (client_id, operation_id, contract_version,
    // occurred_at) is not unique either. `primaryKeyFacts` is empty because the
    // key is declared on the column builder, where `columnFacts` reports it.
    expect(primaryKeyFacts(apiUsage)).toEqual([]);
    expect(columnFacts(apiUsage).id?.isPrimaryKey).toBe(true);
  });

  it('indexes client then time, and time alone, in that order', () => {
    // Two indexes because the two governance reads start from different
    // columns, and a btree is only usable from its leading one: spec §6.4 asks
    // "what did this consumer call" and spec §9.4 asks "who called anything in
    // the last 30 days". Column order is asserted rather than the set — the
    // composite serves only the prefixes of its own ordering, so swapping it to
    // (occurred_at, client_id) would silently make it a duplicate of the second
    // index and leave the retirement query unserved.
    //
    // Ascending for the reason spelled out in `transactions.ts`, even though
    // both reads sort newest first.
    expect(indexFacts(apiUsage)).toEqual([
      {
        name: 'api_usage_client_id_occurred_at_idx',
        columns: ['client_id', 'occurred_at'],
        unique: false,
        method: 'btree',
      },
      {
        name: 'api_usage_occurred_at_idx',
        columns: ['occurred_at'],
        unique: false,
        method: 'btree',
      },
    ]);
  });

  it('makes neither index unique, because a repeated call is the point', () => {
    // Guards the plausible "one row per consumer per operation" upsert design,
    // which would turn the table into a rollup and lose every window query.
    indexFacts(apiUsage).forEach((facts) => {
      expect(facts.unique).toBe(false);
    });
  });
});
