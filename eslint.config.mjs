import baseConfig from './eslint.base.mjs';

/**
 * Root leaf: lints tools/ and root-level files. Each package under
 * packages/* carries its own leaf config extending ../../eslint.base.mjs.
 *
 * @type {import("eslint").Linter.Config} */
export default [
  {
    ignores: [
      'packages/**',
      // Agent-harness prose (skills/agents) was never a lint target in the
      // origin repos either.
      '.claude/**',
      '.plans/**',
      '.specs/**',
      '.tmp/**',
      '.docs/**',
    ],
  },
  ...baseConfig,
];
