import type { Card, CardLifecycleStatus, NewCard } from './cards';

import { expectTypeOf } from 'vitest';

/**
 * Type-level cases for the `cards` row types. See the header of
 * `companies.test-d.ts` for why these live in a `.test-d.ts` and which gate
 * reads them: `bun run check-types`, not `bun run test`.
 */

/**
 * `activatedAt` is `Date | null` on the way out. That `null` stops here — spec
 * §2.5 says the contract never emits one and absent means not applicable — so
 * `service-a`'s card mapper omits the field instead of forwarding it. Pinning
 * the nullability is what makes that mapper's job a stated requirement rather
 * than an implementation detail someone can shortcut.
 */
expectTypeOf<Card>().toEqualTypeOf<{
  id: string;
  companyId: string;
  panLastFour: string;
  lifecycleStatus: 'ordered' | 'issued' | 'active' | 'frozen' | 'terminated';
  activatedAt: Date | null;
  artAssetKey: string;
}>();

/**
 * `activatedAt` is both optional *and* nullable on insert, unlike `id`, which
 * is only optional. A card is normally inserted unactivated, and both spellings
 * of "not yet" reach the same column.
 */
expectTypeOf<NewCard>().toEqualTypeOf<{
  id?: string | undefined;
  companyId: string;
  panLastFour: string;
  lifecycleStatus: 'ordered' | 'issued' | 'active' | 'frozen' | 'terminated';
  activatedAt?: Date | null | undefined;
  artAssetKey: string;
}>();

/**
 * The union the mapper switches over. It carries no `unknown` member: that is
 * a contract convention for consumers reading a value their pinned version
 * predates, and a database enum has no such reader.
 *
 * Stated separately from the `Card` case because this is the type `service-a`
 * will import by name, and because an exhaustive `switch` in the mapper is
 * only exhaustive against whatever this resolves to.
 */
expectTypeOf<CardLifecycleStatus>()
  .toEqualTypeOf<'ordered' | 'issued' | 'active' | 'frozen' | 'terminated'>();
