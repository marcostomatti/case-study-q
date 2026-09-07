/**
 * Deferred-start support for the loop: `--start-at=HH:MM` sleeps until the
 * given local time (tomorrow if the time already passed today), so a run can
 * be queued for off-hours without cron.
 */

/** Parses `HH:MM` (24h) into a delay in milliseconds from `now`. */
export function msUntil(startAt: string, now: Date = new Date()): number {
  const match = startAt.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`--start-at expects HH:MM (24h), got "${startAt}"`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`--start-at expects a valid time of day, got "${startAt}"`);
  }

  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  // If the target time already passed today, assume it means tomorrow.
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

/** Sleeps until the given `HH:MM`, logging the deferral. */
export async function deferUntil(startAt: string): Promise<void> {
  const delayMs = msUntil(startAt);
  console.log(`Deferring execution. Sleeping ${Math.round(delayMs / 1000)}s until ${startAt}...`);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
