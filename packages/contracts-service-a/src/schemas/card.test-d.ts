import type { Card, CardId, CardState } from './card';

import { expectTypeOf } from 'vitest';

/**
 * Type-level cases for the card. Read by `bun run check-types`, not by
 * `bun run test` — see the header of `shared.test-d.ts` for the split.
 */

/** An identifier is a plain string; its bound lives in the JSON. */
expectTypeOf<CardId>().toEqualTypeOf<string>();

/**
 * The union a consumer's `switch` is exhaustive against, `unknown` included.
 *
 * A consumer handling the four real states and not `unknown` compiles today and
 * breaks the first time the provider reports a state added after that
 * consumer's pinned version — which is exactly what spec §2.5 requires the
 * member for. Adding a state here is a change every consumer sees in this type.
 */
expectTypeOf<CardState>().toEqualTypeOf<'inactive' | 'active' | 'frozen' | 'closed' | 'unknown'>();

/**
 * `state` is the narrow union rather than `string`.
 *
 * This is what `Type.Unsafe` buys and a bare `Type.String({ enum })` does not:
 * the same JSON, and no union at all for the consumer. Nothing in
 * `card.test.ts` can tell the two apart, because they emit identically.
 *
 * `activatedAt` is optional and never `null` — absent means the cardholder has
 * not activated the card (spec §2.5).
 */
expectTypeOf<Card>().toEqualTypeOf<{
  id: string;
  lastFour: string;
  state: CardState;
  artUrl: string;
  activatedAt?: string | undefined;
}>();
