import baseConfig from './eslint.base.mjs';

/**
 * Root leaf: lints tools/ and root-level files. Each workspace package under
 * apps/*, packages/* and services/* carries its own leaf config extending
 * ../../eslint.base.mjs.
 *
 * @type {import("eslint").Linter.Config} */
export default [
  {
    ignores: [
      // Every workspace glob declared in package.json. Without these, `eslint .`
      // here reads leaf files with the ROOT config -- whose import resolver
      // points at ./tsconfig.json, which does not include them -- and `lint:all`
      // then lints them a second time through their own leaf config.
      'apps/**',
      'packages/**',
      'services/**',
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
