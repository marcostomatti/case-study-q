# OpenAPI — documenting Express REST APIs

`@asteasolutions/zod-to-openapi` generates the OpenAPI document from the same Zod
schemas that validate requests at runtime, so the document describes the schema a
request is actually parsed against rather than a second one written out beside it.

> **Status:** INSTALLED in `@ar/service`. This rule records what is there, not a
> convention to adopt on some later day. The registry landed in `309e3a2`
> (*feat: assemble an OpenAPI registry from the seventeen binding tables*); around
> it, `5036fda` added the dependency, `4e8c2ef` the `RouteSchemas` type, `5a08e46`
> the export script, `1b80f58` the `docs:openapi` script, and `1ed0df4` plus
> `1528c64` the guarded `GET /docs` mount. Every version and figure below was
> measured at that tip and every one of them moves — re-derive rather than
> quoting.

---

## Setup

1. Dependencies, as `packages/service/package.json` declares them:

```json
"dependencies": {
  "@asteasolutions/zod-to-openapi": "^9.1.0",
  "swagger-ui-express": "^5.0.1"
},
"devDependencies": {
  "@types/swagger-ui-express": "^4.1.8",
  "@seriousme/openapi-schema-validator": "^2.9.1"
}
```

`^9` and not the `^7.3.0` this rule used to pin: 7.x is the zod-3 era, and nothing
below v8 reads zod 4 metadata. `bun.lock` resolves `9.1.0`, whose peer is
`zod: ^4.0.0` and whose one dependency is `openapi3-ts@^4.6.0`. Read the ROOT
manifest's `overrides` block before taking any range here at face value —
`zod` is pinned there at `4.5.1`, which is below this package's own `^4.5.4` floor
and is what actually resolves.

Both runtime halves sit in `dependencies` and not `devDependencies`, because
`src/index.ts` imports the generator at boot to build the document it serves at
`GET /docs`. The schema validator is a devDependency: it is only ever a test's.

2. `src/http/openapi-bindings.ts` — the `RouteSchemas` type and the
   `routeSchemasFor` runtime guard. One binding is up to three schemas: `params`,
   `query` and `body`, each optional, an empty binding legal.

3. One `*RouteSchemas` binding table per router module, exported beside the routes
   it describes. Seventeen of them today, covering 55 routes over 36 paths.

4. `src/openapi.ts` — `buildOpenApiRegistry()` and
   `generateOpenApiDocument()`. Pure assembly over those tables: it declares no
   route, no parameter and no schema of its own.

5. `scripts/export-openapi.ts` — writes `.docs/swagger/openapi.json`.

6. A `docs:openapi` script, **beside** `docs:generate` and never replacing it:

```json
"docs:generate": "typedoc",
"docs:openapi": "bun scripts/export-openapi.ts"
```

Two documentation generators over one package, each owning its own output and
neither reading the other's. They do NOT share a tree, which is worth stating
because the pair of names suggests they do. `docs:openapi` writes the gitignored
`.docs/swagger/`. `docs:generate` is a bare `typedoc` carrying no `typedoc.json`
and no `typedocOptions` key in either `package.json` or `tsconfig.json` — all
three measured absent — so it takes typedoc's own default `out`, which is the
TRACKED `docs/` tree beside it, with `cleanOutputDir` defaulting true. Chaining the
two into one `docs:generate` script, as this rule used to prescribe, would put a
destructive run in front of the artifact half on every invocation.

7. Mount Swagger UI inside `register()`, with the guard spelled explicitly:

```ts
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';

import { generateOpenApiDocument } from './openapi.js';

app.use(
  '/docs',
  ctx.requireAuth,
  helmet.contentSecurityPolicy({
    useDefaults: true,
    directives: {
      scriptSrc: ['\'self\''],
      styleSrc: ['\'self\'', '\'unsafe-inline\''],
    },
  }),
  swaggerUi.serve,
  swaggerUi.setup(generateOpenApiDocument()),
);
```

The guard is EXPLICIT rather than inherited from mount order. The research mounts
above sit at `/` with no path of their own, so their own `ctx.requireAuth` would
refuse an anonymous `GET /docs` anyway — but that is a position and not a
decision, and reordering the block would take it away.

The CSP override relaxes NOTHING, which is the opposite of what a Swagger UI mount
is expected to need. Measured at swagger-ui-express 5.0.1: the page emits three
`src`-referenced same-origin scripts and zero inline ones, so `script-src 'self'`
is helmet's own default restated, and `style-src` is helmet's default MINUS an
unused `https:` source. Measure the emitted tags and the resolved header together
before relaxing anything; the directive a reader predicts needing is the one
already satisfied. Two shapes to expect on the wire: an anonymous refusal carries
the APP-WIDE header, the guard running ahead of the policy, and the un-slashed
`GET /docs` is a `301` from `serve-static` carrying a `default-src 'none'` of its
own.

> **Note:** the mount needs no `@ts-expect-error`. `@types/swagger-ui-express`
> declares `@types/express: "*"`, and a wildcard peer under the isolated linker is
> exactly where a type can resolve to nothing while `skipLibCheck` swallows the
> TS2307 — so check it rather than assume it. The one-token reading is
> `satisfies string` against the value: an `any` passes it, a real type reds
> TS1360. Measured live on both `swaggerUi.serve` and `swaggerUi.setup(...)`'s
> return, so neither had degraded. Do not add the directive defensively either: an
> `@ts-expect-error` whose next line compiles clean is itself an error (TS2578).

---

## The binding table

A route's schemas are declared ONCE, where the handler parses with them, and named
from the table BY IDENTITY. The only thing written a second time is the label —
and a label is exactly what a coverage invariant can hold against the router that
declares it.

```ts
export const domainsRouteSchemas = {
  'GET /domains': { query: paginationQuerySchema },
  'POST /domains': { body: createDomainSchema },
  'GET /domains/:slug': { params: domainAddressSchema },
  'PATCH /domains/:slug': {
    params: domainAddressSchema,
    body: patchDomainSchema,
  },
  'DELETE /domains/:slug': {
    params: domainAddressSchema,
    query: domainDeleteQuerySchema,
  },
} as const satisfies Readonly<Record<string, RouteSchemas>>;
```

This replaces the hand-written `registry.registerPath({ ... })` block this rule
used to carry, per route, with its own `z.object({ ... })` literals. That block was
a SECOND declaration of every request shape, kept in step with the handlers by
nothing at all: a document written that way describes the schema its author had in
mind rather than the one a request meets.

**Rules:**

- `as const satisfies Readonly<Record<string, RouteSchemas>>`, never a bare
  `as const`, which type-checks nothing. Measured: an unknown member is TS2353 (or
  TS2561 when it is one edit away from a real one) and a member bound to a string
  is TS2322. Under a bare `as const` both compile, and the document lies with every
  gate green.
- Keep `satisfies` on the line that CLOSES the literal. It cannot open a
  continuation line — TS1434 plus two cascading parse errors.
- The address consts stay PRIVATE. A table exports the schema OBJECTS and never the
  names they are declared under, so no sibling router gains anything to import.
- Never bind an exported MCP tool-input schema: those merge params and query into
  ONE arguments object, and a document has to keep the two apart. (One route is an
  honest exception, its tool input ALIASING the query const rather than spreading
  it; the table's own TSDoc is where such an exception is written down.)
- Bind what the handler PARSES with. A route that discriminates BEFORE it parses
  binds the branch a caller reaches without asking for the other, and records the
  rest in the table's TSDoc. A union composed for the document is a schema no
  handler parses with, which is the one thing this design forbids.
- An ABSENT member is a claim, and it has four readings: the route reads no body,
  it has no address, it reads no query at all, or the whole binding is `{}` and it
  parses nothing. Say WHICH in the table's TSDoc — a document assembled from
  an unexplained absence describes a refusal, or a parameter, that does not exist.
- The label is the string on the WIRE, mount prefix included. That is what lets
  `tests/invariants/openapi-coverage.test.ts` hold the table's key set against the
  router's own `router.stack`, in both directions and by NAME rather than by count.

Four rules of this surface are outside every table BY CONSTRUCTION, because
`RouteSchemas` declares three members and none of them is one: a value-level
refusal applied after the parse, a header gate, a per-route rate limiter, and the
status a handler chooses. Each belongs in its table's TSDoc, there being nowhere
else to write it — a document assembled from bindings alone describes a route
as reachable by anyone who sends the right body.

---

## `src/openapi.ts` structure

```ts
import type { RouteConfig } from '@asteasolutions/zod-to-openapi';

import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// extendZodWithOpenApi is DELIBERATELY NOT CALLED — see below.
// A component is named with zod 4's own metadata instead.
const successEnvelope = successEnvelopeSchema.meta({ id: 'SuccessEnvelope' });

export function buildOpenApiRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  for (const tagged of ENVELOPE_TABLES) {
    registerTable(registry, tagged, envelopeResponses);
  }

  registerTable(registry, AUTH_TABLE, bareResponses);

  return registry;
}

export type OpenApiDocument =
  ReturnType<OpenApiGeneratorV31['generateDocument']>;

export function generateOpenApiDocument(
  port: number = config.PORT,
): OpenApiDocument {
  const generator = new OpenApiGeneratorV31(
    buildOpenApiRegistry().definitions,
  );

  return generator.generateDocument({
    openapi: '3.1.0',
    info: { title: '...', version: readServiceVersion(), description: '...' },
    servers: [{ url: `http://localhost:${port}` }],
  });
}
```

Build the registry FRESH on every call. A registry is a mutable accumulator, so a
caller generating a document from a shared one after another caller had added to it
gets a document neither of them asked for.

Read `info.version` from the same function the control plane reports through
(`readServiceVersion` in `lib/express/control/version.ts`) rather than writing a
literal, so the version a document claims and the version a running service reports
cannot drift apart.

### `extendZodWithOpenApi` is deliberately not called

It mutates `z.ZodType.prototype` — adding `.openapi()` and wrapping `optional`
and `nullable` — on the SINGLE zod instance the root manifest's `overrides`
block pins, which is the same import every request validator and every MCP tool
input in this package holds. A documentation generator has no business changing how
the service parses requests, and from v8 it does not have to: the library reads
zod 4's native `.meta()`. Measured under the zod 4.5.1 this tree resolves.

Three consequences, each measured:

- `OpenAPIRegistry.register()` is UNUSABLE, and it names the wrong subject when it
  fails. Its one line is `zodSchema.openapi(refId)`, so it answers
  `TypeError: zodSchema.openapi is not a function` rather than anything about
  registration. A task text saying "register the schemas as components" therefore
  describes an API this repo cannot call.
- Name a component with `.meta({ id })` instead. The generator hoists any
  REFERENCED schema carrying an id into `components/schemas` and writes a `$ref` in
  its place, from `registerPath` calls alone. `.meta()` CLONES rather than mutating,
  so the exported const stays untagged and the tagged copy is local to the
  assembling module.
- The library ships a `declare module 'zod'` block, so importing it ANYWHERE puts
  `.openapi()` on `ZodType` for the whole program: `schema.openapi('X')` in an
  unrelated module type-checks CLEAN and throws at runtime. No gate reports it, and
  `check-types` is the gate that structurally cannot. The only reading is a runtime
  case: `src/openapi.test.ts` asserts that the prototype does NOT carry
  `openapi` as an own property, and that `.openapi()` still throws.

### `OpenApiGeneratorV31`, not `OpenApiGeneratorV3`

3.1 is the version whose JSON Schema dialect matches what zod 4 emits. Measured on
`z.coerce.number().int().positive().default(1)`, which every paged route parses:

```text
V3  : { "type": "integer", "minimum": 0, "exclusiveMinimum": true, "default": 1 }
V31 : { "type": "integer", "exclusiveMinimum": 0, "default": 1 }
```

The 3.0 boolean-flag spelling is the tell. Note the document's `openapi` FIELD is
exactly the string handed to `generateDocument`, so asserting it begins `3.1` pins a
constant in the calling module and says nothing about which generator ran —
assert an emission beside it.

Type the return as `ReturnType<OpenApiGeneratorV31['generateDocument']>` rather than
importing `openapi3-ts`: that package is the generator's dependency and not this
one's, so under the isolated linker no specifier here resolves it, and adding one
would be a second pin on a version the generator already chose. The
`as unknown as Record<string, unknown>` cast this rule used to prescribe is neither
needed nor wanted — it throws the type away at the one place a caller reads it.

---

## Describing a schema

`.meta()` and `.describe()`, never `.openapi()`. Both render:

```ts
const Job = z.object({
  id: z.uuid().meta({ example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }),
  status: z.enum(['pending', 'running']).describe('Lifecycle status'),
}).meta({ id: 'Job', description: 'A dispatched execution job' });
```

Emissions worth knowing before writing a test or a doc paragraph against them, all
measured at v9:

- A `.strict()` object BODY answers `additionalProperties: false` at every level,
  nested ones included. The same schema as a QUERY does not: `request.query` is
  SPLIT into one parameter per member, the flag has nowhere to land, and the 422 a
  strict query answers `?pge=2` with is invisible to every consumer of the
  document. Say which half a strictness claim is about.
- `.regex(...)` answers `pattern` carrying the source verbatim, `.max(200)` answers
  `maximum`, and `.default(1)` answers `default` inside the schema AND
  `required: false` on the parameter.
- `z.literal('jsonl')` answers `{ type: 'string', enum: ['jsonl'] }` and not the
  OpenAPI 3.1 `const` keyword. `z.record(z.string(), X)` answers
  `additionalProperties` with NO `propertyNames` — which is exactly where this
  generator and zod's own `z.toJSONSchema()` part company, so a test written against
  the latter describes an emission this toolchain never produces.
- `z.unknown()` renders as `{}` and is ABSENT from the emitted `required` list,
  although zod 4.5.1 requires the key. The document reads more permissive than the
  parse does.
- `generateDocument` always answers `components: { schemas: {}, parameters: {} }`
  and a `webhooks: {}` key even when nothing is registered, so asserting
  `components.schemas` is defined is satisfied by an empty object and pins nothing.
  Assert the component NAMES.
- `request.params` and `request.query` take a ZodObject (or a pipe over one) and
  never a value schema, the object being split into one parameter per member. Narrow
  to `z.ZodObject` and THROW rather than skip: a dropped binding leaves a route in
  the document with its parameters silently undescribed.

---

## Responses

Responses are declared at the ENVELOPE level, once for the whole surface, and never
per record. Nothing here exports a response schema: the records are TypeScript
interfaces shaped at the wire by `ok()` and `okPage()` in `src/http/envelope.ts`,
and deriving one schema per record would be twenty-odd second declarations with
nothing comparing them to the handlers — the exact duplication the identity
rule above exists to forbid. The deferral is recorded as a **Not enforced** row in
`docs/architecture/01-invariants.md` rather than left absent.

What a binding table cannot say is the STATUS. That lives in the handler, where no
generator can see it, and it is not uniform: measured across the 55 routes, eight
deletes answer `204`, nine creates answer `201` and the rest answer `200`. A
per-route status map would be a second authority kept in step with the handlers by
nothing at all. So the success side is declared once — a `2XX` carrying either
envelope, an explicit `204` with NO content (an explicit code outranks its range, so
a delete is not documented as answering a body), a `401`, a `422` only where the
table names a member, and a `500`. The cost is over-declaration, and that is the
honest half to state where the declaration sits.

---

## SSE endpoints

OpenAPI has no native SSE type. Document an SSE route with the `text/event-stream`
content type and a described string:

```ts
responses: {
  200: {
    description: 'Server-Sent Events stream, `data: {...}` frames, 15 s heartbeat',
    content: {
      'text/event-stream': {
        schema: z.string().describe('SSE data frames (JSON-encoded)'),
      },
    },
  },
},
```

No route in the seventeen tables is one today, so this shape is unexercised here. It
would also have to opt out of the uniform response declaration above, which is the
part to think about before adding one.

---

## `scripts/export-openapi.ts`

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateOpenApiDocument } from '../src/openapi.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const OPENAPI_DOCUMENT_FILE = join(
  PACKAGE_ROOT,
  '.docs',
  'swagger',
  'openapi.json',
);

export function exportOpenApiDocument(
  file: string = OPENAPI_DOCUMENT_FILE,
): ExportedDocument {
  const text = `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`;

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);

  return { file, bytes: Buffer.byteLength(text) };
}
```

Resolve the output from THIS FILE's own location and never from `process.cwd()`. A
cwd-built path names the right tree only while the process was started from the
package; launched from the repo root it names a `.docs/swagger/` beside
`packages/`, which the recursive `mkdir` CREATES rather than refuses — so the
failure is a document written where nobody looks, and not an error. Export the path
const, so a reader wanting the artifact names it rather than resolving
`.docs/swagger/` a second time.

Guard the CLI half with `fileURLToPath(import.meta.url) === process.argv[1]`, which
makes the module both a command and a library, and keep those two lines lexically in
the file the command names: `import.meta.url` is the module they are written in, so
a copy moved into a shared helper compares THAT helper and answers false always.

---

## File placement

```text
packages/service/
├── src/
│   ├── http/
│   │   └── openapi-bindings.ts  ← RouteSchemas + routeSchemasFor
│   ├── <group>/routes.ts        ← one *RouteSchemas table per router
│   └── openapi.ts               ← assembly only: registry + document
├── scripts/
│   └── export-openapi.ts        ← writes .docs/swagger/openapi.json
├── tests/invariants/
│   └── openapi-coverage.test.ts ← declared vs documented, both ways
├── docs/                        ← TRACKED; typedoc's default out
└── .docs/                       ← gitignored; written by docs:openapi
    └── swagger/
        └── openapi.json
```

The document is served at `GET /docs` behind `ctx.requireAuth`, built once at boot.
The `.docs/swagger/openapi.json` file is for offline tooling (linters, client
generation, CI spec diffing), and NOTHING in the package reads it back — so a
stale artifact is reported by nothing, there being no diff to dirty. What holds the
document to the routers is `src/openapi.test.ts`, over a document generated in
process, and the coverage invariant over the labels.
