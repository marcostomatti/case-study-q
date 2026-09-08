/**
 * `bun run contracts:emit` — build the OpenAPI document this package
 * publishes and write it to `openapi/openapi.json`.
 *
 * This is gate 1 of the four blocking gates in spec section 8, run on its own
 * against this one contract. `emitOpenApi` throws rather than warning, so a
 * schema the emitted document cannot state stops the build here instead of
 * being reported two gates later as a lint error against a document nobody
 * could have written.
 *
 * ## The document is a committed build artifact, and that is deliberate
 *
 * There is no npm registry in this proof of concept. "Published" means the
 * emitted document is committed — `openapi/openapi.json` is the working emit
 * and `openapi/published/<version>.json` are the baselines gate 3 diffs
 * against. That is the artifact a registry would otherwise hold, and it is
 * what makes the breaking-change gate a real check rather than a described
 * one.
 *
 * Committing a generated file has one failure mode: the committed copy drifts
 * from the schemas, and every later gate then reports on a contract nobody
 * wrote. `serializeDocument` and `OPENAPI_DOCUMENT_PATH` are exported for the
 * byte-identity test that closes it — a test that re-emits and compares needs
 * to write the bytes exactly the way this script does, or it is asserting
 * against its own formatting rather than against the artifact.
 *
 * ## What this script does not do
 *
 * It does not lint, diff or publish. Gate 2 needs `vacuum`, gate 3 needs
 * `oasdiff` and a published baseline, and both belong to `runGates` —
 * spec section 8's order is a governance decision, and a second hand-sequenced
 * copy of it drifts silently. Emitting has to work on a machine with neither
 * binary installed, because it is what produces the document those gates read.
 */
import type { EmitMeta } from '@marcos-corp/contract-tooling';

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emitOpenApi, UnrepresentableSchemaError } from '@marcos-corp/contract-tooling';

import { contract } from '../src/index';

/**
 * `emitOpenApi`'s return type, borrowed rather than imported.
 *
 * The type itself is `openapi3-ts/oas31`'s `OpenAPIObject`, which belongs to
 * `@marcos-corp/contract-tooling` rather than to this package. Importing it
 * here would mean declaring a dependency this package has no other use for,
 * under a linker that resolves every leaf's dependencies separately.
 */
type OpenApiDocument = ReturnType<typeof emitOpenApi>;

/**
 * Everything is resolved from the module's own location, never from
 * `process.cwd()`. `bun run contracts:emit` runs from the package directory
 * and `bun run --filter` does not, and a script that writes its artifact
 * relative to the caller's directory is one invocation away from emitting into
 * the repo root.
 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The working emit: what the mock serves and what gate 2 and gate 3 read. */
export const OPENAPI_DOCUMENT_PATH = join(PACKAGE_ROOT, 'openapi', 'openapi.json');

/** Read for `info.version`, so the document cannot disagree with the package. */
const MANIFEST_PATH = join(PACKAGE_ROOT, 'package.json');

/**
 * A release version, and nothing else.
 *
 * The publish step names a baseline `<major>.<minor>.<patch>.json` after this
 * package's version, and `latestPublishedSpec` throws on any other spelling
 * rather than skipping it — skipping would silently resolve gate 3 to the
 * second-highest version and report "no breaking changes" against a baseline
 * nobody published. Refusing a prerelease here catches that one step earlier,
 * at the point a human can still choose the version.
 */
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

/** Two-space JSON with a trailing newline. See `serializeDocument`. */
const JSON_INDENT = 2;

/**
 * The version consumers pin, read from the manifest rather than restated.
 *
 * Spec section 2.2 makes this package's `version` the reviewable event: every
 * consumer pins it exactly, with no range specifier. The emitted document has
 * to carry the same number or the two artifacts a reviewer compares — the
 * manifest in the consumer's diff and the `info.version` in the contract —
 * disagree about which contract was approved.
 */
function contractVersion(): string {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { version?: unknown };
  const { version } = manifest;

  if (typeof version !== 'string' || !RELEASE_VERSION.test(version)) {
    throw new Error(
      'emit cannot run: package.json must carry a release version spelled '
      + `<major>.<minor>.<patch>, and it carries ${JSON.stringify(version)}`,
    );
  }

  return version;
}

/**
 * Everything in the document that is not derived from the contract.
 *
 * Two of these are governance decisions rather than boilerplate:
 *
 * - **`securitySchemes` is where the credential is stated.** Spec section 2.3
 *   requires every request to carry a `client_id` derived from credentials.
 *   The contract declares no `Authorization` header parameter, because OpenAPI
 *   states that a header parameter with that name SHALL be ignored — declaring
 *   one publishes a requirement no tool reads, which is worse than declaring
 *   nothing because it looks covered. The scheme below is the part a generator,
 *   a mock and a reviewer all act on. Note the consumer presents a credential
 *   and the provider resolves the `client_id` from it: the id is never a field
 *   a caller sends, for the same reason spec section 2.3 rejects `User-Agent`.
 * - **There is no `servers` block.** A base URL is where a deployment lives,
 *   not what the API promises, and this document is published once and read by
 *   `web-a`, `web-b`, `service-b` and the Prism mock — four callers with four
 *   different answers. ts-rest clients take a `baseUrl` and Prism takes a host
 *   and port, so nothing here needs it, and a hardcoded `localhost` in a
 *   published contract is a fact about one laptop.
 */
function emitMeta(): EmitMeta {
  return {
    info: {
      title: 'service-a',
      version: contractVersion(),
      description:
        'Cards, spend and transactions for the company dashboard. Consumers '
        + 'pin this contract package at an exact version and author changes '
        + 'against it; the provider team approves them. See docs/governance.md.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    components: {
      securitySchemes: {
        consumerCredential: {
          type: 'http',
          scheme: 'bearer',
          description:
            'The credential issued to a registered consumer. The provider '
            + 'resolves a client_id from it and records that id against the '
            + 'operation and contract version on every request (spec 2.3), so '
            + 'the id is never something the caller states about itself. An '
            + 'absent or unrecognised credential is the 401 every operation '
            + 'declares.',
        },
      },
    },
    security: [{ consumerCredential: [] }],
  };
}

/**
 * Gate 1: the emitted document, or a throw.
 *
 * Exported so the byte-identity test re-emits through the same path this
 * script writes from. A test that rebuilt the meta itself would compare the
 * committed artifact against its own copy of these decisions and stay green
 * while the two drifted apart.
 */
export function buildDocument(): OpenApiDocument {
  return emitOpenApi(contract, emitMeta());
}

/**
 * The exact bytes `openapi/openapi.json` holds.
 *
 * Byte-identity is the whole reason to commit a generated artifact, so the
 * formatting is part of the contract between this script and the test that
 * checks the committed copy is current: two-space JSON, and a trailing newline
 * because a file without one is a diff hunk on the last line of every future
 * change. Key order comes from `emitOpenApi`, which builds the document in a
 * fixed order — verified there by a case asserting two emits stringify equal.
 */
export function serializeDocument(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, JSON_INDENT)}\n`;
}

/** Renders a thrown value as something an operator can act on. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/**
 * `bun run contracts:emit`.
 *
 * The exit codes carry the split every gate in this repo makes: the contract
 * being unpublishable is a different fact from the emitter being unable to
 * run, and a caller that conflates them turns "the gate is broken" into "your
 * contract is broken".
 *
 *   0  the document was written
 *   1  gate 1 refused the contract — a schema it cannot state
 *   2  the gate could not run — a malformed manifest, an unwritable path
 */
function main(): void {
  try {
    const document = buildDocument();
    mkdirSync(dirname(OPENAPI_DOCUMENT_PATH), { recursive: true });
    writeFileSync(OPENAPI_DOCUMENT_PATH, serializeDocument(document));

    const operations = Object.values(document.paths ?? {})
      .flatMap((pathItem) => Object.values(pathItem as Record<string, { operationId?: string }>))
      .map((operation) => operation.operationId)
      .filter((operationId): operationId is string => typeof operationId === 'string');
    const components = Object.keys(document.components?.schemas ?? {}).length;

    console.log(
      `[contracts:emit] OK — ${operations.length} operations, ${components} components `
      + `-> ${relative(process.cwd(), OPENAPI_DOCUMENT_PATH)}`,
    );
    console.log(`[contracts:emit] operationIds: ${operations.join(', ')}`);
  } catch (err) {
    if (err instanceof UnrepresentableSchemaError) {
      console.error(
        `[contracts:emit] FAIL — gate 1 refused the contract at '${err.path}' `
        + `(${err.reason}): ${err.message}`,
      );
      process.exit(1);
    }

    console.error(`[contracts:emit] FAIL — ${describeError(err)}`);
    process.exit(2);
  }
}

// Runs only when invoked directly, never when imported — the byte-identity
// test imports this module for `buildDocument` and must not write the artifact
// it is checking. `import.meta.url` is a file:// URL and `process.argv[1]` is a
// plain path, so the comparison needs the conversion; without it the guard is
// always false and the CLI silently does nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
