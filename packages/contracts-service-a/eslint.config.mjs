import baseConfig from '../../eslint.base.mjs';

/**
 * Leaf config for @marcos-corp/contracts-service-a. Layers the shared root base
 * on top of the package's own ignores; `bun run lint` here runs from the package
 * directory, so the root leaf deliberately ignores `packages/**` and never
 * double-lints.
 *
 * `openapi/` holds emitted build artifacts (the working emit and the published
 * baselines) — generated JSON, not a lint target.
 *
 * @type {import("eslint").Linter.Config} */
export default [
  { ignores: ['.tmp/**', 'openapi/**'] },
  ...baseConfig,
];
