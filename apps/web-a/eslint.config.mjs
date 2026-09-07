import baseConfig from '../../eslint.base.mjs';

/**
 * Leaf config for @marcos-corp/web-a. Layers the shared root base on top of
 * the package's own ignores; `bun run lint` here runs from the package
 * directory, so the root leaf deliberately ignores `apps/**` and never
 * double-lints.
 *
 * @type {import("eslint").Linter.Config} */
export default [
  { ignores: ['.tmp/**'] },
  ...baseConfig,
];
