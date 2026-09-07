import baseConfig from '../../eslint.base.mjs';

/**
 * Leaf config for @marcos-corp/service-a. Layers the shared root base on top of
 * the package's own ignores; `bun run lint` here runs from the package
 * directory, so the root leaf deliberately ignores `services/**` and never
 * double-lints.
 *
 * @type {import("eslint").Linter.Config} */
export default [
  { ignores: ['.tmp/**'] },
  ...baseConfig,
];
