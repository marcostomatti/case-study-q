#!/usr/bin/env bun

import { getClaudeUsagePercent } from './utils/claude.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- implementation tbd
export default async function usage(_args: string[]): Promise<void> {
  const pct = await getClaudeUsagePercent();

  if (pct === null) {
    console.log('Claude usage: unavailable');
    console.log(
      'Tip: set CLAUDE_USAGE_PERCENT=<0-100> to override until a live source is available.',
    );
    return;
  }

  const bar = buildBar(pct);
  const label =
    pct >= 90
      ? 'CRITICAL — consider pausing'
      : pct >= 80
        ? 'HIGH — monitor closely'
        : pct >= 70
          ? 'ELEVATED'
          : 'OK';

  console.log(`Claude usage: ${pct.toFixed(1)}%  [${bar}]  ${label}`);
}

function buildBar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
