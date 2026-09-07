#!/usr/bin/env bun

/**
 * ralph — spec → plan → loop, in three commands.
 *
 *   bun tools/ralph/ralph.ts plan  --spec=specs/<file>.md [--stub=<name>]
 *   bun tools/ralph/ralph.ts start [--plan=PLAN-<name>.md] [--start-at=HH:MM]
 *   bun tools/ralph/ralph.ts usage
 *
 * (Also available as `bun run ralph <command>`.)
 */
import plan from './plan.js';
import start from './start.js';
import usage from './usage.js';

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'plan':
    await plan(rest);
    break;
  case 'start':
    await start(rest);
    break;
  case 'usage':
    await usage(rest);
    break;
  default:
    console.log([
      'ralph — agent task loop',
      '',
      'Commands:',
      '  plan  --spec=specs/<file>.md [--stub=<name>]   Generate PLAN-<stub>.md (+ PREREQUISITES-<stub>.md) from a spec',
      '  start [--plan=<file>] [--start-at=HH:MM]       Execute a plan task-by-task (resumes blocked tasks first)',
      '  usage                                          Show Claude usage (CLAUDE_USAGE_PERCENT override)',
    ].join('\n'));
    if (command !== undefined && command !== 'help' && command !== '--help') {
      console.error(`\nUnknown command: ${command}`);
      process.exit(1);
    }
}
