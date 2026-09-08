/**
 * Checking a response against the OpenAPI document this contract publishes.
 *
 * ## Why a JSON Schema validator rather than TypeBox
 *
 * The obvious route is `Value.Check(Dashboard, payload)` against the schema
 * the contract package exports, and it does not work: TypeBox's checker is
 * kind-driven, and every contract enum here is `Type.Unsafe`, which is the
 * repo idiom precisely because it emits a real JSON Schema `enum` keyword that
 * house rule 3 can read. Measured on `@sinclair/typebox@0.34.52` — walking a
 * `Card` throws `Unknown type` the moment it reaches `state`, and the
 * alternative spelling (`Type.Unsafe` carrying a `Kind`) is worse: it accepts
 * every string, because the checker never reads a raw `enum` at all.
 * `routes/requestParsing.ts` carries the same measurement from the request
 * direction, where it surfaces as `SCHEMA_NOT_CHECKABLE`.
 *
 * So the claim "this payload validates against the contract" is made against
 * the emitted document with `ajv`, which is a JSON Schema 2020-12 validator —
 * the dialect OpenAPI 3.1 embeds unmodified, which is why `emit.ts` picked
 * 3.1 in the first place. `ajv-formats` is what makes `format: 'date-time'`
 * and `format: 'uri'` constraints rather than annotations.
 *
 * ## Why the emitted document rather than the exported schemas
 *
 * Three reasons, and the third is the governance one.
 *
 * - The exported TypeBox schemas cannot be compiled as they stand: they inline
 *   the same `$id`-carrying schema at several positions, so `MonetaryAmount`
 *   appears twice and ajv refuses with `resolves to more than one schema`.
 *   `emitOpenApi` hoists each `$id` into `components.schemas` and leaves a
 *   `$ref`, which is exactly the shape a validator wants.
 * - The document states which schema each operation answers with, so a case
 *   names an `operationId` and gets the schema the contract declares for it,
 *   rather than a component a test author picked by name.
 * - It is the artifact every other reader of this contract sees: the Prism
 *   mock serves it, `oasdiff` diffs it, and a consumer's generated client is
 *   built from it. "The provider answers what the mock promises" is the
 *   property this repository exists to demonstrate, and it is only a property
 *   of the emitted document.
 *
 * The working emit is read rather than a published baseline: a baseline is
 * frozen at the version it was published under and legitimately differs from
 * the tree on any change that has not shipped yet. Whether the working emit is
 * itself current is owned by `packages/contracts-service-a/scripts/emit.test.ts`,
 * which compares it byte for byte against a fresh emit — nothing here can make
 * that claim, and a document that had drifted would validate a payload against
 * fiction.
 *
 * Test support, deliberately **not** re-exported from `src/index.ts`, for the
 * reason `src/testing/seededDatabase.ts` gives. It lives under `src/` so
 * `bun run check-types` and `bun run lint` both read it.
 */
import type { ErrorObject, ValidateFunction } from 'ajv';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

/**
 * Prefixes every failure that means the check never ran.
 *
 * The same split every gate in `@marcos-corp/contract-tooling` makes, and it
 * matters more here than usual: a validator that could not find the schema it
 * was asked for must never be mistaken for a payload that satisfied it.
 */
export const CONTRACT_CHECK_CANNOT_RUN = 'contract check cannot run:';

/** The only response media type this contract publishes. */
const JSON_MEDIA_TYPE = 'application/json';

/**
 * The base the component `$ref`s resolve against.
 *
 * Arbitrary but not absent: ajv needs a registered identifier to hang
 * `#/components/schemas/...` off, and the document itself declares none.
 */
const DOCUMENT_SCHEMA_ID = 'published-contract';

/** As much of the emitted document as anything here reads. */
interface PublishedDocument {
  readonly openapi: string;
  readonly info: { readonly version: string };
  readonly paths: Record<string, Record<string, PublishedOperation>>;
  readonly components: { readonly schemas: Record<string, unknown> };
}

interface PublishedOperation {
  readonly operationId?: string;
  readonly responses?: Record<string, {
    readonly content?: Record<string, { readonly schema?: { readonly $ref?: string } }>;
  }>;
}

/** What a payload did or did not satisfy, and which schema said so. */
export interface ResponseCheck {
  readonly ok: boolean;
  /** The reference the document states for this operation and status. */
  readonly schemaRef: string;
  /** One line per violation, empty when the payload satisfied the schema. */
  readonly problems: readonly string[];
}

/** The emitted document, loaded and compiled. */
export interface PublishedContract {
  /** Where it was read from. Asserted, so a case cannot validate against a stray file. */
  readonly documentPath: string;
  /** `info.version` — the number a consumer pins. */
  readonly version: string;
  /** The `$ref` this document declares for one operation's response body. */
  responseSchemaRef(operationId: string, status: number): string;
  /** Checks a payload against that schema. */
  checkResponse(operationId: string, status: number, payload: unknown): ResponseCheck;
}

/**
 * The emitted document, found through the dependency rather than by counting
 * directory separators.
 *
 * `import.meta.resolve` goes through this package's declared dependency on
 * `@marcos-corp/contracts-service-a`, so moving this file inside `src/` cannot
 * break it and a package that stopped declaring the contract would fail here
 * rather than silently read a path that happened to still exist.
 */
export const PUBLISHED_DOCUMENT_PATH = fileURLToPath(new URL(
  '../openapi/openapi.json',
  import.meta.resolve('@marcos-corp/contracts-service-a'),
));

function readDocument(path: string): PublishedDocument {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(
      `${CONTRACT_CHECK_CANNOT_RUN} the emitted contract document is not at '${path}'. `
      + 'Run `bun run contracts:emit` in packages/contracts-service-a.',
      { cause },
    );
  }

  try {
    return JSON.parse(source) as PublishedDocument;
  } catch (cause) {
    throw new Error(
      `${CONTRACT_CHECK_CANNOT_RUN} the document at '${path}' is not JSON`,
      { cause },
    );
  }
}

/**
 * The `$ref` the document states for one operation's response body.
 *
 * Keyed on `operationId` rather than on a method and path, because that is the
 * name the contract's own router keys produce, the name `api_usage` records
 * under spec section 2.3, and the only one a reader of a case would recognise.
 */
function findResponseSchemaRef(
  document: PublishedDocument,
  operationId: string,
  status: number,
): string {
  for (const operations of Object.values(document.paths)) {
    for (const operation of Object.values(operations)) {
      if (operation.operationId !== operationId) {
        continue;
      }

      const schema = operation.responses?.[String(status)]?.content?.[JSON_MEDIA_TYPE]?.schema;
      const reference = schema?.$ref;
      if (reference === undefined) {
        throw new Error(
          `${CONTRACT_CHECK_CANNOT_RUN} operation '${operationId}' declares no `
          + `${JSON_MEDIA_TYPE} schema for status ${String(status)}`,
        );
      }

      return `${DOCUMENT_SCHEMA_ID}${reference}`;
    }
  }

  throw new Error(
    `${CONTRACT_CHECK_CANNOT_RUN} the emitted document declares no operation '${operationId}'`,
  );
}

/** One line per violation, in the order ajv reported them. */
function describe(errors: readonly ErrorObject[]): string[] {
  return errors.map((error) => {
    const where = error.instancePath === ''
      ? '(root)'
      : error.instancePath;

    return `${where} ${error.message ?? 'is invalid'}`;
  });
}

/**
 * Reads the emitted document and hands back something that can check a payload
 * against it.
 *
 * Call once per file. Compiling a schema is not free and the document does not
 * change while a suite runs.
 */
export function loadPublishedContract(): PublishedContract {
  const document = readDocument(PUBLISHED_DOCUMENT_PATH);
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);

  // The registered root is an OpenAPI container rather than a schema, and
  // `components` is not a JSON Schema keyword — declaring it is what lets the
  // rest of the document stay under ajv's strict mode, where an unknown
  // keyword inside a component schema is still an error.
  ajv.addKeyword({ keyword: 'components' });
  ajv.addSchema(
    { components: { schemas: document.components.schemas } },
    DOCUMENT_SCHEMA_ID,
  );

  const compiled = new Map<string, ValidateFunction>();

  function validatorFor(schemaRef: string): ValidateFunction {
    const existing = compiled.get(schemaRef);
    if (existing !== undefined) {
      return existing;
    }

    const validate = ajv.compile({ $ref: schemaRef });
    compiled.set(schemaRef, validate);
    return validate;
  }

  return {
    documentPath: PUBLISHED_DOCUMENT_PATH,
    version: document.info.version,
    responseSchemaRef: (operationId, status) => findResponseSchemaRef(document, operationId, status),
    checkResponse: (operationId, status, payload) => {
      const schemaRef = findResponseSchemaRef(document, operationId, status);
      const validate = validatorFor(schemaRef);
      const ok = validate(payload);

      return { ok, schemaRef, problems: describe(validate.errors ?? []) };
    },
  };
}
