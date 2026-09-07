# TSDoc — inline code documentation

Use TSDoc for all TypeScript symbols in this repo. TSDoc is a superset of JSDoc that
TypeDoc can parse and render. Always use `/** */` blocks, never `//` for documentation.

---

## File-level: `@packageDocumentation`

Every source file must begin with a `@packageDocumentation` block describing what the module does.
Place it **before** all imports.

```ts
/**
 * @packageDocumentation
 * Data-access helpers for the nodes and jobs tables.
 */
import type { Db } from '../db/index.js';
```

---

## Functions and methods

Always include `@param`, `@returns`, and `@throws` where applicable.

```ts
/**
 * Looks up a single node by its identifier.
 *
 * @param db - Drizzle database instance.
 * @param nodeId - The node identifier (e.g. `"pi-01"`).
 * @returns The node row, or `null` if not found.
 */
export async function getNode(db: Db, nodeId: string) { ... }
```

```ts
/**
 * Dispatches a job to a specific node.
 *
 * @param db - Drizzle database instance.
 * @param node - Target node (must have a non-null address).
 * @param params - Job dispatch parameters.
 * @returns The inserted job row.
 * @throws {Error} If the node has no address or the executor returns a non-2xx response.
 */
export async function dispatchJobToNode(db: Db, node: ..., params: ...) { ... }
```

**Rules:**
- `@param name - description` — dash separator, lowercase start unless a proper noun.
- `@returns` — describe shape, not just type. Use `null` in backticks when applicable.
- `@throws {ErrorType}` — document every thrown error and the condition that triggers it.
- One-liner functions with obvious signatures may omit `@param`/`@returns` if the names are self-evident, but still need a summary line.

---

## Classes

Document the class itself with its invariants and ownership model.
Document every public method individually.

```ts
/**
 * Central registry for entity type definitions.
 *
 * Each entity plugin calls `registry.register(definition)` during service
 * startup. Routes use `registry.get(kind)` for payload validation.
 *
 * Intentionally synchronous — no async resolution, no lazy loading.
 * All plugins must register before the HTTP server accepts requests.
 */
export class EntityRegistry {
  /**
   * Registers an entity plugin definition.
   *
   * @param definition - The plugin to register.
   * @throws {Error} If the kind is already registered.
   */
  register(definition: EntityTypeDefinition): void { ... }

  /**
   * Looks up a registered plugin by kind.
   *
   * @param kind - The entity kind to look up.
   * @returns The plugin definition, or `undefined` if not registered.
   */
  get(kind: EntityKind): EntityTypeDefinition | undefined { ... }
}
```

---

## Interfaces and types

Document the interface and any non-obvious fields.

```ts
/**
 * Contract each entity plugin must satisfy when registering with the hub.
 */
export interface EntityTypeDefinition {
  kind: EntityKind;

  /** Whether this entity type supports the approval (request/response) pattern. */
  interactive: boolean;

  /**
   * Optional delivery hook — called after the event is persisted and fanned out.
   * Fire-and-forget; errors are logged but do not affect the HTTP response.
   */
  deliver?(payload: Record<string, unknown>): Promise<void>;
}
```

Document type aliases when their intent is non-obvious:

```ts
/** Identifies the logical category of a notification entity. */
export type EntityKind = 'executor' | 'mail' | 'push' | 'webhook';
```

---

## Express router factories

Router factories document the HTTP surface they expose via `@remarks`.

```ts
/**
 * Express router for the `/approvals` human-gate workflow.
 *
 * @param db - Drizzle database instance.
 * @returns Configured Express Router.
 *
 * @remarks
 * **Endpoints**
 * - `POST /approvals` — create approval request; returns `201`
 * - `GET  /approvals?jobId=&pending=true` — list pending approvals
 * - `GET  /approvals/:requestId/wait` — SSE stream; resolves on decision
 * - `POST /approvals/:requestId/decide` — submit grant or deny decision
 */
export function approvalsRouter(db: Db): Router { ... }
```

The `@remarks` section replaces the old "plain comment above exports" pattern.
Use fenced code or backtick-formatted route paths for clarity.

---

## React components

Document props interfaces and the component itself.

```tsx
/**
 * Props for the {@link JobStatusBadge} component.
 */
export interface JobStatusBadgeProps {
  /** Current job lifecycle status. */
  status: JobStatus;
  /** Additional CSS class names. */
  className?: string;
}

/**
 * Displays a colour-coded badge for a job's current status.
 *
 * @param props - {@link JobStatusBadgeProps}
 */
export function JobStatusBadge({ status, className }: JobStatusBadgeProps) { ... }
```

---

## MCP tool handlers

Document each tool with its purpose, parameters, and what it returns to the model.

```ts
/**
 * Searches the knowledge base for documents matching a query.
 *
 * @param query - Natural-language search query.
 * @param limit - Maximum number of results to return (default: 10).
 * @returns JSON array of matching document excerpts with metadata.
 *
 * @remarks
 * Called by the MCP client when the model invokes the `search_documents` tool.
 * Returns an empty array when no documents match — never throws.
 */
async function handleSearchDocuments(query: string, limit = 10): Promise<string> { ... }
```

---

## What NOT to document inline

- Obvious getters/setters (`getId(): string` needs no JSDoc).
- Private implementation details that are already explained by a parent class or module comment.
- Generated code (Drizzle schema inferred types, OpenAPI client types).
- Test helper functions with self-descriptive names.
