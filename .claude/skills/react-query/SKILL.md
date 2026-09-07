---
name: react-query
description: >
  Use this skill when adding data fetching, caching, polling, or server-state
  management to a React app that consumes this library. Covers useQuery,
  useMutation, provider setup, query key conventions, and live-polling
  patterns for job status (via the components-library/cache subpath export).
---

> Scope: file paths in this document are relative to `packages/ui/` (the `@marcos-corp/ui` package), except `.claude/`, `.plans/`, and `.specs/`, which live at the umbrella repo root.

# React Query via components-library/cache

This library ships **TanStack Query v5** through the `components-library/cache`
subpath export. All imports in consuming apps go through that subpath — never
import from `@tanstack/react-query` directly.

---

## Setup

### 1. Add the dependency

```json
// package.json — the cache module rides along with the component library
"components-library": "<version>"
```

### 2. Wrap the app

```tsx
// src/main.tsx
import { QueryClientProvider, defaultQueryClient } from 'components-library/cache';

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={defaultQueryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
```

`QueryProvider` (also exported) is the zero-config alternative — it owns an
SSR-safe singleton client (30s `staleTime`, `retry: 1`), so use it when you
don't need to hold the client yourself.

---

## Available exports

### Browser entry (`components-library/cache`)

For read-only data fetching, **prefer `useCache` over raw `useQuery`** — it applies sensible defaults (`staleTime: 60_000`, `gcTime: 300_000`, `refetchOnWindowFocus: false`) and is the recommended abstraction for all read-only queries:

```ts
import { useCache, QueryClientProvider, defaultQueryClient } from 'components-library/cache';
```

#### `useCache` usage

```ts
const { data, isLoading, isError, error, refetch } = useCache(
  ['projects', teamId],          // query key array
  () => api.getProjects(teamId), // fetcher
  { enabled: !!teamId },         // optional overrides
);
```

Override defaults as needed:

```ts
useCache(['workflowStates', teamId], fetcher, {
  staleTime: Infinity,   // never re-fetch unless explicitly invalidated
  enabled: !!teamId,
});
```

For mutations, polling, or advanced query control, the lower-level hooks are also available:

```ts
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from 'components-library/cache';
```

### Server entry (`components-library/cache/server`)

For server-side Redis-backed caching (never import this in browser code — the build gate fails if `ioredis` leaks into the browser bundle):

```ts
import { createServerCache } from 'components-library/cache/server';
```

`createServerCache(redis)` takes an `ioredis` instance — `ioredis` is an
optional peer dependency, installed only by server consumers. Wiring lives in
`src/cache/server.ts`.

---

## Query key conventions

Keys are arrays. Use the entity name followed by any filter parameters:

```ts
['projects', teamId]          // team projects list
['activeJobs']                // all active jobs (running + paused)
['currentTask', jobId]        // current task for a specific job
['approvals']                 // all pending approvals
['approvals', jobId]          // approvals for a specific job
['nodes']                     // executor node list
['workflowStates', teamId]    // workflow states (static — staleTime: Infinity)
```

Invalidate queries after mutations:

```ts
const queryClient = useQueryClient();
await queryClient.invalidateQueries({ queryKey: ['activeJobs'] });
await queryClient.invalidateQueries({ queryKey: ['approvals', jobId] });
```

---

## Live polling patterns

### Polling every 30 seconds (active jobs)

```ts
const { data: activeJobs = [] } = useQuery({
  queryKey: ['activeJobs'],
  queryFn: (): Promise<JobRecord[]> =>
    notifyClient ? notifyClient.getActiveJobs(['running', 'paused']) : Promise.resolve([]),
  refetchInterval: 30_000,
  enabled: !!notifyClient,
});
```

### Polling every 5 seconds (current task — fast loop feedback)

```ts
const { data: currentTaskRes } = useQuery({
  queryKey: ['currentTask', jobId],
  queryFn: () => notifyClient!.getJobCurrentTask(jobId!),
  refetchInterval: 5_000,
  enabled: !!notifyClient && !!jobId && jobStatus === 'running',
});
```

### Static data (workflow states, project list)

```ts
const { data: workflowStates } = useQuery({
  queryKey: ['workflowStates', teamId],
  queryFn: () => getWorkflowService().then(svc => svc.getTeamWorkflowStates(teamId)),
  staleTime: Infinity,    // never re-fetch unless explicitly invalidated
  enabled: !!teamId,
});
```

---

## Mutation pattern (with optimistic invalidation)

```ts
const queryClient = useQueryClient();

async function handlePause(jobId: string, nodeAddress: string) {
  await notifyClient.pauseJob(jobId, nodeAddress);
  await queryClient.invalidateQueries({ queryKey: ['activeJobs'] });
}
```

For mutations that need loading/error state, use `useMutation`:

```ts
const pauseMutation = useMutation({
  mutationFn: ({ jobId, nodeAddress }: { jobId: string; nodeAddress: string }) =>
    notifyClient!.pauseJob(jobId, nodeAddress),
  onSuccess: () => {
    void queryClient.invalidateQueries({ queryKey: ['activeJobs'] });
  },
});
```

---

## `enabled` guard pattern

Always guard queries that depend on external services with `enabled`:

```ts
const notifyClient = getNotificationClient(); // returns null if VITE_NOTIFICATION_URL unset

const { data } = useQuery({
  queryKey: ['nodes'],
  queryFn: () => notifyClient!.listNodes(),
  enabled: !!notifyClient,
});
```

---

## Enriching nodes with live data (without re-fetching the slow source)

When a tree has both slow (upstream API) and fast-polling (job status) data,
separate concerns with `useMemo` instead of putting polling data in the build
callback:

```ts
// baseNodes: set by the slow upstream build callback
// activeJobs: polled every 30s via useQuery
const nodes = useMemo(() => {
  const jobBySourceId = new Map(activeJobs.map(j => [j.sourceId ?? '', j]));
  return baseNodes.map(node => {
    const job = jobBySourceId.get(node.data.issueId);
    if (!job) return node;
    return { ...node, data: { ...node.data, jobId: job.id, jobStatus: job.status } };
  });
}, [baseNodes, activeJobs]);
```

This keeps the slow upstream calls low while job status stays fresh.

---

## Key files

| File | Purpose |
|------|---------|
| `src/cache/browser.ts` | Browser entry — `useCache` + re-exported TanStack hooks, `QueryClientProvider` |
| `src/cache/provider.tsx` | `QueryProvider` — zero-config, SSR-safe singleton client |
| `src/cache/queryClient.ts` | `defaultQueryClient` |
| `src/cache/server.ts` | Server entry — `createServerCache` (Redis cache-aside) |
| `src/cache/__tests__/` | Unit tests for both entries (jsdom project) |
