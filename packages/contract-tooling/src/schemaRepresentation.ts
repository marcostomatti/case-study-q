/**
 * Decides whether a single schema can be published, and returns the form the
 * emitted document carries. The contract walking that feeds it is in
 * `./emit.ts`; this module knows nothing about ts-rest.
 *
 * ## What "cannot be represented" means, and how it is decided
 *
 * Structurally, not by a list of TypeBox constructors — a deny-list goes
 * stale the moment TypeBox adds a JavaScript-only type. The four rules are:
 *
 *   1. A `type` that is not one of JSON Schema's seven. TypeBox spells its
 *      JavaScript-only types as `{"type":"Date"}`, `{"type":"undefined"}`,
 *      `{"type":"bigint"}`, `{"type":"Function"}` and so on (measured on
 *      `@sinclair/typebox@0.34.52`); every one of them is a `type` no
 *      consumer, mock server or diff tool can read.
 *   2. A node that constrains nothing. `Type.Any()` and `Type.Unknown()` both
 *      emit `{}`, which is the spec section 2.4 failure verbatim.
 *   3. A `TypeBox.Transform`. Its decode and encode functions are invisible in
 *      the emitted JSON Schema, so the document under-states the contract.
 *      This is the one the two rules above cannot see: `Type.Transform` over a
 *      string emits a perfectly ordinary `{"type":"string"}`.
 *   4. A value that is not a schema at all — a Zod schema, an array, a
 *      primitive, or `c.type<T>()`. That last one matters most: it is what
 *      ts-rest documents for non-Zod schemas, it type-checks perfectly, and at
 *      runtime it is the bare symbol `Symbol(ContractPlainType)` with no
 *      schema behind it.
 *
 * Deliberately NOT decided here: whether a representable schema is a *good*
 * one. A typeless `{"not":{}}` from `Type.Never()`, an object with no
 * `additionalProperties`, an enum with no `unknown` member — all emit, and all
 * are gate 2's business. Emit answers "can this be published at all"; the
 * house ruleset answers "should it be". Splitting them keeps each gate's
 * output about one thing.
 *
 * ## The split between a throw and a finding
 *
 * Unlike gates 2, 3 and 4, gate 1 reports everything by throwing: spec section
 * 8 says emit *fails* on unrepresentable constructs, and there is no partial
 * document worth handing to the next gate. The two causes are still
 * distinguishable, and `gates.ts` needs them to be:
 *
 *   - `UnrepresentableSchemaError` — a schema in the contract cannot be
 *     published. Carries the `path` that names it and a `reason`.
 *   - a plain `Error` prefixed `emit gate cannot run:` — the contract or the
 *     metadata is malformed in a way that is not about any one schema.
 */
import type { ReferenceObject, SchemaObject } from 'openapi3-ts/oas31';

import { ContractPlainTypeRuntimeSymbol } from '@ts-rest/core';

/** Where a hoisted schema lands, and the only ref target this gate emits. */
export const COMPONENT_REF_PREFIX = '#/components/schemas/';

/** The seven types JSON Schema defines. Anything else is a JavaScript type. */
const JSON_SCHEMA_TYPES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
]);

/**
 * TypeBox marks a `Type.Transform` with this symbol. It is registered with
 * `Symbol.for`, so looking it up by key rather than importing it from
 * `@sinclair/typebox` matches across TypeBox instances — which under bun's
 * isolated linker is the normal case, not the exotic one: each contract
 * package resolves its own copy.
 */
const TRANSFORM_KIND = Symbol.for('TypeBox.Transform');

/** Keywords whose value is a single subschema (or, in 2020-12, a boolean). */
const SUBSCHEMA_KEYWORDS = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

/** Keywords whose value is an array of subschemas. */
const SUBSCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

/** Keywords whose value is a map of name to subschema. */
const SUBSCHEMA_MAP_KEYWORDS = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);

/**
 * Every keyword that restricts what a value may be. A node carrying none of
 * them publishes nothing, whatever annotations it also carries.
 *
 * Generous on purpose. The claim this gate makes is "this states *nothing*",
 * which is `Type.Any()` and `Type.Unknown()`; a node that states too little to
 * be useful — `{"format":"date-time"}` with no type, say — is house rule 1's
 * call, and reporting one node from two gates under two names helps nobody.
 */
const CONSTRAINING_KEYWORDS = new Set([
  '$ref',
  'allOf',
  'anyOf',
  'const',
  'contains',
  'dependentRequired',
  'dependentSchemas',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'if',
  'items',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'not',
  'oneOf',
  'pattern',
  'patternProperties',
  'prefixItems',
  'properties',
  'propertyNames',
  'required',
  'type',
  'uniqueItems',
]);

/** Why a schema cannot be published. */
export type UnrepresentableReason =
  /** Not a schema object: a primitive, an array, a class instance, a symbol. */
  | 'not-a-schema'
  /** `c.type<T>()` — a compile-time type with no runtime schema behind it. */
  | 'compile-time-type'
  /** A `type` outside JSON Schema's seven, e.g. TypeBox's `Date` or `Function`. */
  | 'non-json-schema-type'
  /** `{}` and friends: no keyword that restricts anything. */
  | 'unconstrained'
  /** A `TypeBox.Transform`, whose coercion the emitted document cannot state. */
  | 'transform'
  /** A `$ref` naming something this document does not contain. */
  | 'unresolvable-ref';

/**
 * Thrown when the contract carries a schema the emitted document cannot state.
 * Separate from the plain `Error` gate 1 throws when it cannot run at all, so
 * `gates.ts` can report "the contract is unpublishable" and "the gate is
 * broken" as the different things they are.
 */
export class UnrepresentableSchemaError extends Error {
  /**
   * Where the offending schema sits, rooted at the contract: the route's key
   * path, the slot, then the JSON Schema keywords down to the node — e.g.
   * `getCompanyDashboard.responses.200.properties.card.properties.activatedAt`.
   */
  readonly path: string;

  readonly reason: UnrepresentableReason;

  constructor(path: string, reason: UnrepresentableReason, detail: string) {
    super(`emit gate cannot represent '${path}': ${detail}`);
    this.name = 'UnrepresentableSchemaError';
    this.path = path;
    this.reason = reason;
  }
}

/**
 * The other half of gate 1's failures: the gate cannot run, rather than the
 * contract being unpublishable. Shared with `./emit.ts` so both spell the
 * prefix once — a caller asserting on it is asserting on one string.
 */
export const cannotRun = (detail: string): Error => new Error(`emit gate cannot run: ${detail}`);

export const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Names a value in a message without printing a whole object graph. */
export function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'symbol') return `the symbol ${String(value)}`;
  if (typeof value === 'function') return 'a function';
  return `a ${typeof value} (${JSON.stringify(value) ?? String(value)})`;
}

/** The components hoisted so far, and the refs still owed a definition. */
export interface SchemaHoistContext {
  /** Schemas lifted out of the contract by their `$id`, keyed by that `$id`. */
  readonly components: Map<string, SchemaObject>;
  /** `$id`s currently being built, so a self-referential schema terminates. */
  readonly hoisting: Set<string>;
  /** Every ref emitted, with where it came from, so all can be resolved at the end. */
  readonly referenced: { name: string; path: string }[];
}

export const createHoistContext = (): SchemaHoistContext => ({
  components: new Map(),
  hoisting: new Set(),
  referenced: [],
});

/**
 * Zod's own markers, across both majors: `_def` on a v3 schema, `_zod` and the
 * standard-schema entry on a v4 one. Only used to make the message pointed — a
 * Zod schema fails the `unconstrained` check anyway, with a message about `{}`
 * that sends the reader looking in the wrong place.
 */
const isZodSchema = (value: Record<string, unknown>): boolean => '_def' in value || '_zod' in value || '~standard' in value;

/**
 * Everything that decides a single node is publishable. Split out from the
 * rebuild below so the caller-supplied `components.schemas` entries go through
 * exactly the same checks as the schemas found in the contract.
 */
export function assertRepresentable(
  value: unknown,
  path: string,
): asserts value is Record<string, unknown> {
  if (value === ContractPlainTypeRuntimeSymbol) {
    throw new UnrepresentableSchemaError(
      path,
      'compile-time-type',
      'this is `c.type<T>()`, which ts-rest keeps at compile time only — at runtime it is a '
      + 'bare symbol with no schema behind it, so the emitted document would state nothing '
      + 'here. Author the schema in TypeBox and pass the schema object itself',
    );
  }

  if (!isPlainObject(value)) {
    throw new UnrepresentableSchemaError(
      path,
      'not-a-schema',
      `expected a JSON Schema object and found ${describeValue(value)}`,
    );
  }

  if (TRANSFORM_KIND in value) {
    throw new UnrepresentableSchemaError(
      path,
      'transform',
      'this is a `Type.Transform`, whose decode and encode functions do not appear in the '
      + 'emitted JSON Schema — the document would understate the contract, and oasdiff could '
      + 'not detect a change to the coercion. Spec section 2.4: domain coercion belongs in the '
      + 'service handler, after parse',
    );
  }

  if (isZodSchema(value)) {
    throw new UnrepresentableSchemaError(
      path,
      'not-a-schema',
      'this is a Zod schema, which is not JSON Schema. Contract packages author in TypeBox; '
      + 'if Zod is ever used here it goes through `z.toJSONSchema()` with '
      + '`unrepresentable: "throw"` first, never `"any"`',
    );
  }

  if ('type' in value) {
    const declared = Array.isArray(value['type'])
      ? value['type']
      : [value['type']];
    const foreign = declared.filter(
      (entry) => typeof entry !== 'string' || !JSON_SCHEMA_TYPES.has(entry),
    );
    if (foreign.length > 0) {
      throw new UnrepresentableSchemaError(
        path,
        'non-json-schema-type',
        `type ${foreign.map((entry) => JSON.stringify(entry)).join(', ')} is not a JSON Schema `
        + `type (${[...JSON_SCHEMA_TYPES].sort().join(', ')}). TypeBox spells its `
        + 'JavaScript-only types this way — Date, Undefined, Void, BigInt, Symbol, Uint8Array, '
        + 'Function, Constructor and Promise all emit a type no consumer can read',
      );
    }
  }

  const constrains = Object.keys(value).some((key) => CONSTRAINING_KEYWORDS.has(key));
  if (!constrains) {
    throw new UnrepresentableSchemaError(
      path,
      'unconstrained',
      'this schema restricts nothing, so it publishes nothing: a consumer cannot derive a type '
      + 'from it and oasdiff cannot detect a change to it. `Type.Any()` and `Type.Unknown()` '
      + 'both emit `{}`, which is the failure spec section 2.4 forbids',
    );
  }
}

/**
 * Rewrites a `$ref` onto this document's own `#/components/schemas/` space and
 * records it for resolution once every component is known.
 *
 * A bare name is accepted because that is what `Type.Ref('Error')` emits.
 * Anything pointing outside this document is refused: the emitted artifact is
 * mounted as one file by Prism and diffed as one file by oasdiff, so a ref it
 * cannot resolve is a document that only looks complete.
 */
function normaliseRef(value: unknown, path: string, context: SchemaHoistContext): string {
  if (typeof value !== 'string' || value === '') {
    throw new UnrepresentableSchemaError(
      path,
      'unresolvable-ref',
      `expected a $ref string and found ${describeValue(value)}`,
    );
  }

  let name = value;
  if (value.startsWith(COMPONENT_REF_PREFIX)) {
    name = value.slice(COMPONENT_REF_PREFIX.length);
  } else if (value.includes('/') || value.includes('#')) {
    throw new UnrepresentableSchemaError(
      path,
      'unresolvable-ref',
      `$ref '${value}' points outside this document. The emitted artifact is self-contained — `
      + 'Prism mounts one file and oasdiff diffs one file — so every ref resolves into '
      + `'${COMPONENT_REF_PREFIX}'`,
    );
  }

  context.referenced.push({ name, path });
  return `${COMPONENT_REF_PREFIX}${name}`;
}

/**
 * Rebuilds a node, recursing into subschemas by keyword rather than by walking
 * every object it finds.
 *
 * Keyword-driven is the load-bearing part. A generic deep walk would descend
 * into `const`, `default` and `examples`, which hold values rather than
 * schemas, and would then report a `{"type":"Date"}` sitting in a `const` as an
 * unrepresentable schema when it is a perfectly ordinary example value.
 *
 * The input is never mutated; every level returns a fresh object.
 */
function buildSchemaNode(
  value: Record<string, unknown>,
  path: string,
  context: SchemaHoistContext,
): SchemaObject {
  const built: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    // `$id` is consumed by the hoist that brought us here: a component's name
    // is its key under `components.schemas`, and a stray `$id` left inside a
    // 3.1 document is a second, competing identity for the same schema.
    if (key === '$id') continue;

    if (key === '$ref') {
      built[key] = normaliseRef(entry, path, context);
      continue;
    }

    if (SUBSCHEMA_KEYWORDS.has(key)) {
      // 2020-12 lets these be `true` or `false`, which are complete schemas.
      built[key] = typeof entry === 'boolean'
        ? entry
        : representSchema(entry, `${path}.${key}`, context);
      continue;
    }

    if (SUBSCHEMA_ARRAY_KEYWORDS.has(key)) {
      if (!Array.isArray(entry)) {
        throw new UnrepresentableSchemaError(
          `${path}.${key}`,
          'not-a-schema',
          `expected an array of schemas and found ${describeValue(entry)}`,
        );
      }
      built[key] = entry.map(
        (item, index) => representSchema(item, `${path}.${key}.${index}`, context),
      );
      continue;
    }

    if (SUBSCHEMA_MAP_KEYWORDS.has(key)) {
      if (!isPlainObject(entry)) {
        throw new UnrepresentableSchemaError(
          `${path}.${key}`,
          'not-a-schema',
          `expected a map of name to schema and found ${describeValue(entry)}`,
        );
      }
      built[key] = Object.fromEntries(Object.entries(entry).map(
        ([name, subSchema]) => [name, representSchema(subSchema, `${path}.${key}.${name}`, context)],
      ));
      continue;
    }

    built[key] = entry;
  }

  // JSON Schema 2020-12 carries keywords `SchemaObject` does not enumerate --
  // `$defs`, `if`/`then`/`else`, `patternProperties`, `unevaluated*` -- and
  // OpenAPI 3.1 embeds 2020-12 unmodified, so the document is right and the
  // interface is narrow. One cast, at the one boundary where that is true.
  return built as SchemaObject;
}

/**
 * Lifts a schema carrying `$id` into `components.schemas` and leaves a `$ref`
 * in its place.
 *
 * This is what makes house rule 5 satisfiable at all. That rule runs with
 * `resolved: false` and requires every 4xx/5xx response to carry a literal
 * `{"$ref": "#/components/schemas/Error"}`; an inlined copy of the same shape
 * satisfies no rule and drifts from the original the first time one is edited.
 *
 * Two schemas sharing an `$id` with different bodies is refused rather than
 * settled by last-writer-wins, because whichever one lost would still be
 * referenced everywhere it appeared.
 */
function hoistComponent(
  value: Record<string, unknown>,
  id: string,
  path: string,
  context: SchemaHoistContext,
): ReferenceObject {
  context.referenced.push({ name: id, path });
  const reference: ReferenceObject = { $ref: `${COMPONENT_REF_PREFIX}${id}` };

  // Already being built further up the stack: a self-referential schema, and
  // the ref above is exactly what it needs.
  if (context.hoisting.has(id)) return reference;

  context.hoisting.add(id);
  const built = buildSchemaNode(value, path, context);
  context.hoisting.delete(id);

  const existing = context.components.get(id);
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(built)) {
    throw cannotRun(
      `two different schemas, one of them at '${path}', both carry $id '${id}', so one would be `
      + 'published under the other\'s name. Give them distinct ids, or export one schema and '
      + 'reuse it',
    );
  }
  context.components.set(id, built);

  return reference;
}

/** Validates a schema and returns its emittable form, hoisting it if it is named. */
export function representSchema(
  value: unknown,
  path: string,
  context: SchemaHoistContext,
): SchemaObject | ReferenceObject {
  assertRepresentable(value, path);

  const id = value['$id'];
  if (typeof id === 'string' && id !== '') return hoistComponent(value, id, path, context);

  return buildSchemaNode(value, path, context);
}

/**
 * A component supplied through `meta` rather than found in the contract. It is
 * already at its home under `components.schemas`, so it is built rather than
 * hoisted — hoisting it would replace it with a `$ref` to itself.
 */
export function representComponent(
  value: unknown,
  path: string,
  context: SchemaHoistContext,
): SchemaObject {
  assertRepresentable(value, path);
  return buildSchemaNode(value, path, context);
}
