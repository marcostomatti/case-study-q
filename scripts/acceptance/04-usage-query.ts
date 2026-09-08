#!/usr/bin/env bun

/**
 * Acceptance criterion 4 (spec §9.4):
 *
 *   "A query returns which `client_id`s called which endpoint at which
 *    contract version over the last 30 days."
 *
 * Drives traffic from all three registered consumers against the running
 * service, then answers that question with one SQL statement over `api_usage`.
 *
 * Requires the demo stack:
 *
 *   bun run demo:up
 *   bun scripts/acceptance/04-usage-query.ts
 *
 * This is the criterion that cannot be retrofitted. Spec §2.3 puts identity in
 * the MVP with only three consumers precisely because the affected-consumer
 * list a major version needs (§6.2) and the "is anyone still calling this
 * field" check that gates retirement (§6.4) both read rows that only exist if
 * identity was recorded from the first request onward.
 */

import { Pool } from 'pg';

import { Narrative } from './harness';

/** Matches `scripts/demo.ts`; override together with it. */
const DATABASE_URL = process.env.DATABASE_URL
  ?? `postgres://${process.env.POSTGRES_USER ?? 'governance'}`
  + `:${process.env.POSTGRES_PASSWORD ?? 'governance'}`
  + `@127.0.0.1:${process.env.POSTGRES_PORT ?? '55432'}`
  + `/${process.env.POSTGRES_DB ?? 'governance'}`;

const SERVICE_URL = process.env.SERVICE_A_URL ?? `http://127.0.0.1:${process.env.SERVICE_A_PORT ?? '53000'}`;

const SEED_COMPANY_ID = '11111111-1111-4111-8111-111111111111';

/** The credentials `services/service-a/src/main.ts` registers for the demo. */
const CONSUMERS = [
  { clientId: 'web-a', credential: 'demo-web-a-token' },
  { clientId: 'web-b', credential: 'demo-web-b-token' },
  { clientId: 'service-b', credential: 'demo-service-b-token' },
] as const;

/** The window spec §9.4 names. */
const WINDOW_DAYS = 30;

/**
 * The query the criterion asks for: who called what, at which contract version,
 * over the last 30 days.
 */
const USAGE_QUERY = `
  SELECT client_id,
         operation_id,
         contract_version,
         COUNT(*)::int AS calls,
         MAX(occurred_at) AS last_called_at
    FROM api_usage
   WHERE occurred_at >= NOW() - ($1 || ' days')::interval
   GROUP BY client_id, operation_id, contract_version
   ORDER BY client_id, operation_id
`;

interface UsageRow {
  client_id: string;
  operation_id: string;
  contract_version: string;
  calls: number;
  last_called_at: Date;
}

const story = new Narrative('Acceptance 4 — usage is queryable per consumer, operation and contract version');

const pool = new Pool({ connectionString: DATABASE_URL });

try {
  story.step('Drive traffic: each registered consumer calls a different operation.');

  const driven: string[] = [];
  for (const consumer of CONSUMERS) {
    const headers = { Authorization: `Bearer ${consumer.credential}` };

    const listed = await fetch(`${SERVICE_URL}/companies`, { headers });
    const dashboard = await fetch(`${SERVICE_URL}/companies/${SEED_COMPANY_ID}/dashboard`, { headers });

    story.expect(
      `${consumer.clientId} is served (listCompanies ${listed.status}, getCompanyDashboard ${dashboard.status})`,
      listed.ok && dashboard.ok,
    );
    if (listed.ok && dashboard.ok) driven.push(consumer.clientId);
  }

  // A refused request must be logged too, or the table cannot answer "who is
  // calling with a credential we never issued".
  const refused = await fetch(`${SERVICE_URL}/companies`, {
    headers: { Authorization: 'Bearer not-a-registered-credential' },
  });
  story.expect('an unregistered credential is refused with 401', refused.status === 401);

  story.step(`Query: group ${WINDOW_DAYS} days of api_usage by consumer, operation and contract version.`);

  const { rows } = await pool.query<UsageRow>(USAGE_QUERY, [String(WINDOW_DAYS)]);

  console.log('');
  console.log('  client_id   operation_id           version  calls  last_called_at');
  console.log('  ----------  ---------------------  -------  -----  --------------------');
  for (const row of rows) {
    console.log(
      `  ${row.client_id.padEnd(10)}  ${row.operation_id.padEnd(21)}  `
      + `${row.contract_version.padEnd(7)}  ${String(row.calls).padStart(5)}  `
      + `${row.last_called_at.toISOString()}`,
    );
  }
  console.log('');

  story.expect('the query returns rows', rows.length > 0);

  for (const clientId of driven) {
    story.expect(
      `\`${clientId}\` appears in the usage table`,
      rows.some((row) => row.client_id === clientId),
    );
  }

  story.expect(
    'every row names the contract version it was served at',
    rows.length > 0 && rows.every((row) => row.contract_version.length > 0),
  );

  story.expect(
    'both operations are distinguishable, not collapsed into one endpoint',
    new Set(rows.map((row) => row.operation_id)).size >= 2,
    [...new Set(rows.map((row) => row.operation_id))].join(', '),
  );

  // The whole point of §2.3 is telling consumers apart. One shared identity
  // across three consumers would satisfy every check above except this one.
  story.expect(
    'the three consumers are distinguishable from one another',
    new Set(rows.map((row) => row.client_id)).size >= driven.length,
    `${new Set(rows.map((row) => row.client_id)).size} distinct client_id(s)`,
  );
} catch (error) {
  const message = error instanceof Error
    ? error.message
    : String(error);
  story.expect('the demo stack is reachable', false, `${message}\nRun \`bun run demo:up\` first.`);
} finally {
  await pool.end();
}

process.exitCode = story.finish();
