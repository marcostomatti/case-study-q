/**
 * The contract packages the gates run over, resolved from the repository root.
 *
 * One list, imported by `scripts/pipeline-simulation.ts`, the CI contracts job
 * and the acceptance scripts. A second hand-maintained list is how a new
 * contract package silently escapes the gates.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, derived from this file rather than from `cwd`. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where contract packages live. */
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages');

/** The prefix that marks a package as a published contract. */
const CONTRACT_DIR_PREFIX = 'contracts-';

export interface ContractPackage {
  /** The npm name, e.g. `@marcos-corp/contracts-service-a`. */
  name: string;
  /** Absolute path to the package directory. */
  dir: string;
  /** Path relative to the repository root, for readable output. */
  relativeDir: string;
  /** The version consumers pin, read from the manifest. */
  version: string;
  /** Absolute path to the emitted working document. */
  specPath: string;
}

/**
 * Lists every `packages/contracts-*` package, sorted by name so output ordering
 * is stable across machines — `readdirSync` is not sorted on every filesystem,
 * and an unstable gate report reads as a change when nothing changed.
 */
export function contractPackages(): ContractPackage[] {
  return fs
    .readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(CONTRACT_DIR_PREFIX))
    .map((entry) => {
      const dir = path.join(PACKAGES_DIR, entry.name);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
      ) as { name: string; version: string };

      return {
        name: manifest.name,
        dir,
        relativeDir: path.relative(REPO_ROOT, dir),
        version: manifest.version,
        specPath: path.join(dir, 'openapi', 'openapi.json'),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Lists every package that consumes a contract — the ones the pin gate reads.
 *
 * Providers are included on purpose: `service-a` pins the contract it publishes
 * exactly like a consumer does, because a provider drifting from its own
 * published contract is the same failure as a consumer drifting from it.
 */
export function consumingPackages(): { name: string; dir: string; relativeDir: string }[] {
  const roots = ['apps', 'services', 'packages'];

  return roots
    .flatMap((root) => {
      const rootDir = path.join(REPO_ROOT, root);
      if (!fs.existsSync(rootDir)) return [];

      return fs
        .readdirSync(rootDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(rootDir, entry.name));
    })
    .filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
    .map((dir) => {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
      ) as { name: string };
      return { name: manifest.name, dir, relativeDir: path.relative(REPO_ROOT, dir) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
