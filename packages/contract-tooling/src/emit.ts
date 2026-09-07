/**
 * Gate 1 of the four blocking gates in spec section 8: build the OpenAPI
 * document from a ts-rest contract, and fail on any construct the emitted
 * document cannot state.
 *
 * It runs first for a reason. A lint error reported against a document that
 * could not be built is a message about the wrong thing, and a diff taken
 * against a document that silently dropped half a payload reports "no
 * breaking changes" about a contract nobody wrote.
 *
 * What counts as unpublishable, and why a throw rather than a finding, is in
 * `./schemaRepresentation.ts`. This module is the contract half: walking the
 * router, turning routes into operations, and assembling the document.
 *
 * ## Why this is hand-rolled rather than `@ts-rest/open-api`
 *
 * Measured on `@ts-rest/open-api@3.52.1`, which is the obvious thing to reach
 * for. It depends on `@anatine/zod-openapi` and reads a schema only through
 * `isZodType`. Handed the TypeBox contract this repo authors, it emits the
 * operation with `responses: { '200': { description: '200' } }` — no
 * `content`, no schema, exit 0. That is exactly the failure spec section 2.4
 * names when it forbids `unrepresentable: "any"`: the build passes with a
 * contract that says nothing. It also takes a non-optional `zod` peer, which
 * contract packages are not allowed to carry.
 *
 * TypeBox schemas are already JSON Schema and OpenAPI 3.1 embeds JSON Schema
 * 2020-12 unmodified, so there is no conversion step here to get wrong. The
 * work is walking the contract, deciding what is publishable, and hoisting
 * named schemas into `components`.
 */
import type { SchemaHoistContext } from './schemaRepresentation';
import type { AppRoute, AppRouter } from '@ts-rest/core';
import type {
  ComponentsObject,
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  PathItemObject,
  PathsObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  ResponsesObject,
  SchemaObject,
} from 'openapi3-ts/oas31';

import { ContractNoBody, isAppRoute } from '@ts-rest/core';

import {
  cannotRun,
  createHoistContext,
  describeValue,
  isPlainObject,
  representComponent,
  representSchema,
  UnrepresentableSchemaError,
} from './schemaRepresentation';

/**
 * Emitted into every document and not overridable. TypeBox produces JSON
 * Schema 2020-12, which only OpenAPI 3.1 embeds unmodified; 3.0 would need a
 * lossy rewrite (`nullable`, boolean `exclusiveMinimum`, no `const`), and
 * lossy conversion is the thing spec section 5 chose TypeBox to avoid.
 *
 * Checked against the rest of the toolchain rather than assumed: vacuum 0.30.3
 * lints a 3.1 document against the house ruleset, and oasdiff 1.31.0 reports
 * `response-required-property-removed` across a 3.1 pair.
 */
export const OPENAPI_VERSION = '3.1.0';

/**
 * A Response Object's `description` is required by OpenAPI, so something has
 * to fill it. The schema's own `description` wins; this is the fallback, and it
 * covers the statuses this repo's contracts use.
 */
const REASON_PHRASES: Record<string, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** The default request media type, overridable per route by ts-rest. */
const DEFAULT_CONTENT_TYPE = 'application/json';

/** The media type every response in this repo's contracts is served as. */
const RESPONSE_CONTENT_TYPE = 'application/json';

/** `:companyId` in a ts-rest path. */
const PATH_VARIABLE = /:([A-Za-z_$][A-Za-z0-9_$]*)/g;

/** A response key this gate accepts: a bare HTTP status code. */
const STATUS_CODE = /^[1-5]\d{2}$/;

/** Where a parameter is carried. Path params get their own handling. */
type ParameterLocation = 'path' | 'query' | 'header';

/**
 * Everything about the document that is not derived from the contract.
 *
 * `openapi` is fixed by this module and `paths` is what it builds, so neither
 * is a caller's to supply. The shape otherwise matches `OpenAPIObject`, which
 * already makes `info` required — the same convention `@ts-rest/open-api`
 * uses, so a reader who knows that signature knows this one.
 */
export type EmitMeta = Omit<OpenAPIObject, 'openapi' | 'paths'>;

/** A route paired with the router keys that reached it. */
interface CollectedRoute {
  keys: string[];
  route: AppRoute;
}

/** `/companies/:companyId/dashboard` -> `/companies/{companyId}/dashboard`. */
const toOpenApiPath = (path: string): string => path.replace(PATH_VARIABLE, '{$1}');

/** The variable names a ts-rest path declares, in order of appearance. */
const pathVariables = (path: string): string[] => [...path.matchAll(PATH_VARIABLE)].map((match) => match[1] ?? '');

/**
 * Explodes a `pathParams` / `query` / `headers` object schema into parameters.
 *
 * The container itself never appears in the emitted document — OpenAPI has
 * nowhere to put it — so only its property schemas are checked and emitted. A
 * container with no `properties` yields nothing, which is the normal case for
 * `headers`: `c.router()` puts an empty object there on every route.
 */
function buildParameters(
  container: unknown,
  location: ParameterLocation,
  path: string,
  context: SchemaHoistContext,
): ParameterObject[] {
  if (container === undefined) return [];

  if (!isPlainObject(container) || ('type' in container && container['type'] !== 'object')) {
    throw cannotRun(
      `'${path}' must be an object schema, because OpenAPI carries ${location} parameters one `
      + `by one rather than as a single value. Found ${describeValue(container)}`,
    );
  }

  const properties = container['properties'];
  if (properties === undefined) return [];
  if (!isPlainObject(properties)) {
    throw cannotRun(`'${path}.properties' must be a map of name to schema`);
  }

  const declaredRequired = container['required'];
  const required = new Set(Array.isArray(declaredRequired)
    ? declaredRequired
    : []);

  return Object.entries(properties).map(([name, schema]) => {
    // OpenAPI requires every path parameter to be required. Silently
    // correcting an optional one would publish a promise the contract does
    // not make, so it is refused instead.
    if (location === 'path' && !required.has(name)) {
      throw cannotRun(
        `path parameter '${name}' at '${path}' is optional, but a path parameter is always `
        + 'required — the URL cannot be built without it',
      );
    }

    return {
      name,
      in: location,
      required: location === 'path'
        ? true
        : required.has(name),
      schema: representSchema(schema, `${path}.${name}`, context),
    };
  });
}

/**
 * Builds the responses map.
 *
 * `c.noBody()` is the only way to declare a response with no payload. A bare
 * `null` is refused: ts-rest's type permits it, but it reads as an unfinished
 * route far more often than as a deliberate empty body, and the two are
 * indistinguishable once emitted.
 */
function buildResponses(
  responses: unknown,
  path: string,
  context: SchemaHoistContext,
): ResponsesObject {
  if (!isPlainObject(responses)) {
    throw cannotRun(`'${path}' must be a map of status code to schema`);
  }

  const statuses = Object.keys(responses);
  if (statuses.length === 0) {
    throw cannotRun(`'${path}' declares no responses, so the operation states no outcome`);
  }

  const built: ResponsesObject = {};

  for (const status of [...statuses].sort()) {
    if (!STATUS_CODE.test(status)) {
      throw cannotRun(
        `'${path}.${status}' is not an HTTP status code. This gate emits status-keyed responses `
        + 'only, so that house rule 5 can select the error ones by code',
      );
    }

    const schema = responses[status];
    const description = isPlainObject(schema) && typeof schema['description'] === 'string'
      ? schema['description']
      : REASON_PHRASES[status] ?? `Response ${status}`;

    if (schema === ContractNoBody) {
      built[status] = { description } satisfies ResponseObject;
      continue;
    }

    built[status] = {
      description,
      content: {
        [RESPONSE_CONTENT_TYPE]: { schema: representSchema(schema, `${path}.${status}`, context) },
      },
    } satisfies ResponseObject;
  }

  return built;
}

/**
 * Copies the `x-` prefixed keys of a route's `metadata` onto the operation,
 * and nothing else.
 *
 * ts-rest has a `deprecated` flag but nowhere to put the sunset date house
 * rule 4 requires alongside it, which would otherwise leave a deprecated
 * operation impossible to publish. Bounding the copy to `x-` keeps internal
 * metadata — the sort a service uses for routing or auth — out of the document
 * a consumer reads.
 */
function extensionsFrom(metadata: unknown): Record<string, unknown> {
  if (!isPlainObject(metadata)) return {};

  return Object.fromEntries(Object.entries(metadata).filter(([key]) => key.startsWith('x-')));
}

/** Refuses a path template and a `pathParams` schema that do not agree. */
function assertPathParamsMatchTemplate(
  route: AppRoute,
  parameters: ParameterObject[],
  keyPath: string,
): void {
  const declared = pathVariables(route.path);
  const emitted = parameters
    .filter((parameter) => parameter.in === 'path')
    .map((parameter) => parameter.name);

  const missing = declared.filter((name) => !emitted.includes(name));
  const undeclared = emitted.filter((name) => !declared.includes(name));
  if (missing.length === 0 && undeclared.length === 0) return;

  throw cannotRun(
    `'${keyPath}' declares path '${route.path}' and pathParams [${emitted.join(', ')}], which do `
    + 'not agree. OpenAPI requires every path template variable to have a parameter and every '
    + `path parameter to appear in the template (missing: [${missing.join(', ')}], not in the `
    + `path: [${undeclared.join(', ')}])`,
  );
}

/** Builds one operation, and the parameters and body it carries. */
function buildOperation(
  route: AppRoute,
  operationId: string,
  keyPath: string,
  context: SchemaHoistContext,
): OperationObject {
  const parameters = [
    ...buildParameters(route.pathParams, 'path', `${keyPath}.pathParams`, context),
    ...buildParameters(route.query, 'query', `${keyPath}.query`, context),
    ...buildParameters(route.headers, 'header', `${keyPath}.headers`, context),
  ];
  assertPathParamsMatchTemplate(route, parameters, keyPath);

  // A freshly built local, never a caller's object. The conditional keys are
  // what keep an absent `summary` out of the emitted document rather than
  // landing there as an explicit `undefined`.
  const operation: OperationObject = { operationId, ...extensionsFrom(route.metadata) };
  if (typeof route.summary === 'string') operation.summary = route.summary;
  if (typeof route.description === 'string') operation.description = route.description;
  if (route.deprecated === true) operation.deprecated = true;
  if (parameters.length > 0) operation.parameters = parameters;

  const body = 'body' in route
    ? route.body
    : undefined;
  if (body !== undefined && body !== ContractNoBody) {
    const contentType = 'contentType' in route && typeof route.contentType === 'string'
      ? route.contentType
      : DEFAULT_CONTENT_TYPE;

    operation.requestBody = {
      required: true,
      content: { [contentType]: { schema: representSchema(body, `${keyPath}.body`, context) } },
    } satisfies RequestBodyObject;
  }

  operation.responses = buildResponses(route.responses, `${keyPath}.responses`, context);

  return operation;
}

/**
 * Walks the router, which ts-rest allows to nest, and returns every route with
 * the keys that reached it.
 */
function collectRoutes(node: AppRouter, keys: string[], collected: CollectedRoute[]): void {
  for (const [key, entry] of Object.entries(node)) {
    // Shape first, then `isAppRoute`, and not the other way round: ts-rest
    // implements it as `'method' in obj`, which throws a TypeError on a
    // string or a number rather than returning false.
    if (!isPlainObject(entry)) {
      throw cannotRun(
        `'${[...keys, key].join('.')}' is neither a route nor a nested router, it is `
        + `${describeValue(entry)}`,
      );
    }

    if (isAppRoute(entry)) {
      collected.push({ keys: [...keys, key], route: entry });
      continue;
    }

    collectRoutes(entry, [...keys, key], collected);
  }
}

/**
 * The router keys are the operationId: `{ companies: { getDashboard } }`
 * becomes `companiesGetDashboard`, and a top-level `getCompanyDashboard`
 * becomes itself.
 *
 * Derived rather than declared, so house rule 5's "operationId present" is
 * structurally satisfied instead of being a convention someone has to
 * remember — and so the id a contract author reads in their own code is the
 * one `api_usage` records under spec section 2.3.
 */
const operationIdFor = (keys: string[]): string => keys
  .map((key, index) => (index === 0
    ? key
    : `${key.charAt(0).toUpperCase()}${key.slice(1)}`))
  .join('');

/** Turns the collected routes into `paths`, refusing any pair that would collide. */
function buildPaths(collected: CollectedRoute[], context: SchemaHoistContext): PathsObject {
  const paths: PathsObject = {};
  const seenOperationIds = new Map<string, string>();

  for (const { keys, route } of collected) {
    const keyPath = keys.join('.');
    const operationId = operationIdFor(keys);

    const clash = seenOperationIds.get(operationId);
    if (clash !== undefined) {
      throw cannotRun(
        `'${keyPath}' and '${clash}' both produce operationId '${operationId}', which OpenAPI `
        + 'requires to be unique and which spec section 2.3 keys api_usage on',
      );
    }
    seenOperationIds.set(operationId, keyPath);

    if (!route.path.startsWith('/')) {
      throw cannotRun(`'${keyPath}' declares path '${route.path}', which does not start with '/'`);
    }

    const templated = toOpenApiPath(route.path);
    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    const pathItem: PathItemObject = paths[templated] ?? {};
    if (pathItem[method] !== undefined) {
      throw cannotRun(
        `'${keyPath}' is a second ${route.method} on '${templated}'; one path and method carry `
        + 'one operation',
      );
    }

    pathItem[method] = buildOperation(route, operationId, keyPath, context);
    paths[templated] = pathItem;
  }

  return paths;
}

/**
 * Merges the schemas hoisted out of the contract with those `meta` supplied,
 * then checks that every ref emitted has somewhere to land.
 */
function resolveSchemas(
  supplied: Record<string, SchemaObject | ReferenceObject>,
  context: SchemaHoistContext,
): Record<string, SchemaObject | ReferenceObject> {
  // Sorted, so the committed artifact does not churn when a route moves.
  const schemas = { ...supplied };
  for (const name of [...context.components.keys()].sort()) {
    const hoisted = context.components.get(name);
    if (hoisted === undefined) continue;

    const fromMeta = schemas[name];
    if (fromMeta !== undefined && JSON.stringify(fromMeta) !== JSON.stringify(hoisted)) {
      throw cannotRun(
        `meta.components.schemas['${name}'] and a schema in the contract carrying $id '${name}' `
        + 'are different, so which one is published would depend on the order they were found',
      );
    }
    schemas[name] = hoisted;
  }

  for (const { name, path } of context.referenced) {
    if (name in schemas) continue;

    throw new UnrepresentableSchemaError(
      path,
      'unresolvable-ref',
      `$ref names '${name}', which this document does not define. A schema becomes a component `
      + 'by carrying `$id`, or by being supplied in `meta.components.schemas`',
    );
  }

  // Sorted by code unit rather than by locale: the emitted document is a
  // committed artifact compared byte for byte, and `localeCompare` orders
  // differently under a different ICU build.
  return Object.fromEntries(
    Object.entries(schemas).sort(([a], [b]) => (a < b
      ? -1
      : 1)),
  );
}

/**
 * Builds the OpenAPI 3.1 document for `contract`.
 *
 * Throws `UnrepresentableSchemaError`, naming the offending path, on any
 * schema the document cannot state; throws a plain `Error` prefixed `emit gate
 * cannot run:` when the contract or the metadata is malformed in a way that is
 * not about one schema.
 *
 * Schemas carrying `$id` are hoisted into `components.schemas` under that id
 * and referenced by `$ref`; anything `meta.components.schemas` supplies is
 * validated the same way and merged with them.
 */
export function emitOpenApi(contract: AppRouter, meta: EmitMeta): OpenAPIObject {
  if (!isPlainObject(contract)) {
    throw cannotRun(`the contract is not a ts-rest router, it is ${describeValue(contract)}`);
  }

  const collected: CollectedRoute[] = [];
  collectRoutes(contract, [], collected);
  if (collected.length === 0) {
    throw cannotRun('the contract declares no routes, so there is nothing to publish');
  }

  const context = createHoistContext();

  // Caller-supplied components go first, so a contract schema referencing one
  // by name resolves against a component that has already been checked.
  const supplied: Record<string, SchemaObject | ReferenceObject> = {};
  for (const [name, schema] of Object.entries(meta.components?.schemas ?? {})) {
    supplied[name] = representComponent(schema, `components.schemas.${name}`, context);
  }

  const paths = buildPaths(collected, context);
  const schemas = resolveSchemas(supplied, context);

  const components: ComponentsObject = { ...meta.components };
  if (Object.keys(schemas).length > 0) components.schemas = schemas;

  const document: OpenAPIObject = { openapi: OPENAPI_VERSION, ...meta, paths };
  if (Object.keys(components).length > 0) document.components = components;

  return document;
}

export type { UnrepresentableReason } from './schemaRepresentation';
export { COMPONENT_REF_PREFIX, UnrepresentableSchemaError } from './schemaRepresentation';
