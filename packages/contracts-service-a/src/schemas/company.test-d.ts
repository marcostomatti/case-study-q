import type { CompanyId, CompanySummary } from './company';

import { expectTypeOf } from 'vitest';

/**
 * Type-level cases for the company selector's schema. Read by
 * `bun run check-types`, not by `bun run test` — see the header of
 * `shared.test-d.ts` for the split and why it is not redundancy.
 */

/**
 * An identifier is a plain string, and stays one.
 *
 * The bound and the absence of a format live in the JSON, which
 * `company.test.ts` owns. What this pins is the other direction: an id that
 * became a branded or templated type here would be a change every consumer has
 * to absorb in its own TypeScript, invisible in the emitted document and so
 * invisible to the diff gate.
 */
expectTypeOf<CompanyId>().toEqualTypeOf<string>();

/**
 * Both fields are required, and there is no third.
 *
 * An optional field added here would compile at every consumer and change what
 * the selector can rely on. That is the change spec §6.1 wants to be cheap and
 * spec §6.2 wants to be visible — this case is what makes it visible in the
 * type as well as in the document.
 */
expectTypeOf<CompanySummary>().toEqualTypeOf<{ id: string; name: string }>();
