# pwa-cache-kit

[![CI](https://github.com/rbalukja15/pwa-cache-kit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rbalukja15/pwa-cache-kit/actions/workflows/ci.yml)

An offline-first cache for Progressive Web Apps that keeps each value in memory, SessionStorage
and IndexedDB, and reads it from the fastest tier that has it.

> **Status:** early development. The API is specified in
> [ADR-0002](./docs/adr/0002-cache-api-and-semantics.md) and is being implemented; nothing is
> published to npm yet.

## The three tiers

| Tier           | Shared by                          | Survives                               | Access                                |
| -------------- | ---------------------------------- | -------------------------------------- | ------------------------------------- |
| Memory         | one page or worker                 | nothing: lost on reload                | synchronous, any value                |
| SessionStorage | one tab (windows only)             | reloads of that tab                    | synchronous, JSON-safe values         |
| IndexedDB      | all tabs and workers of the origin | restarts, unless the browser evicts it | asynchronous, structured-clone values |

Each kind of data lives in a namespace that sets the tiers holding it (its **tier policy**), its
time to live and its schema version. Reads check the policy's tiers from the top and stop at the
first fresh copy. A copy found lower down is promoted to the tiers above it, so the next read is
fast. Writes go to every tier in the policy.

```mermaid
flowchart LR
  get(["get(key)"]) --> memory[Memory]
  memory -- miss --> session[SessionStorage]
  session -- miss --> idb[IndexedDB]
  idb -- miss --> none(["undefined"])
  session -. "hit: copied up" .-> memory
  idb -. "hit: copied up" .-> session
  idb -. "hit: copied up" .-> memory
```

Which tiers to pick for which data is covered in the
[decision guide](./docs/decision-guide.md), and why there are three tiers in
[ADR-0001](./docs/adr/0001-three-tier-cache.md).

## Usage

The full API and its semantics are specified in
[ADR-0002](./docs/adr/0002-cache-api-and-semantics.md). `getOrSet` is not implemented yet (#25).

```ts
import { createCache, indexedDBTier, memoryTier } from '@rbalukja/pwa-cache-kit';

interface Ticket {
  id: string;
  seat: string;
}

const cache = createCache({ name: 'app', tiers: [memoryTier(), indexedDBTier()] });

// Tier failures are reported as events, never thrown from reads, so log them while developing.
cache.on('error', (event) => console.warn(event.error));

const tickets = cache.namespace<Ticket>('tickets', {
  tiers: ['memory', 'indexeddb'],
  ttlMs: 5 * 60_000,
});

await tickets.set('t1', { id: 't1', seat: '12A' });
const cached = await tickets.get('t1'); // Ticket | undefined
```

## Events

`cache.on(type, handler)` subscribes to one event type and returns a function that unsubscribes;
`cache.off(type, handler)` does the same. The cache inspector is built on these events only.

```ts
const off = cache.on('hit', (event) => {
  console.log(`${event.namespace}/${event.key} served by ${event.tier}`);
});
off();
```

Every event has a `type`, and all but `error` and a whole-cache `clear` carry the `namespace`, `key`
and `tier` they are about. The other fields depend on the type:

| Type      | Emitted when a tier                   | Extra fields                                                           |
| --------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `hit`     | serves a fresh value                  | `sizeBytes`, `freshUntil?`, `expiresAt?`                               |
| `miss`    | walked by a read has no fresh value   | `reason`: absent, stale, expired, newer, invalid, error                |
| `set`     | stores a value                        | `sizeBytes`, `freshUntil?`, `expiresAt?`, `reason`: set, load, migrate |
| `promote` | receives a copy of a lower tier's hit | `from`, `sizeBytes`, `freshUntil?`, `expiresAt?`                       |
| `delete`  | is told to remove a key               | `reason`: delete, remote                                               |
| `clear`   | is told to clear a namespace or cache | `reason`: clear, remote; no `namespace` or `key` for the whole cache   |
| `expire`  | removes an expired entry              |                                                                        |
| `evict`   | removes a live entry to make room     | `sizeBytes`, `reason`: budget, quota                                   |
| `error`   | fails                                 | `error` (a `CacheError`); `namespace`, `key` and `tier` when known     |

`sizeBytes` is the entry's estimated size. `freshUntil` and `expiresAt` are times in ms since the
epoch, absent when the copy never goes stale or never expires; subtract `Date.now()` for the time
to live left. `delete` and `clear` are emitted for every tier the call covers, whether or not that
tier held anything.

A read that misses memory and is served by IndexedDB emits `miss` (memory), `hit` (indexeddb), then
`promote` (memory, `from: 'indexeddb'`). Handlers run synchronously, in the order the effects
happen and in registration order, and each handler is called once per event even if registered
twice. A handler that throws is reported through `reportError` and does not break the operation
or the other handlers. When a type has no handler the cache builds no event for it, so unused
events cost nothing.

## Server-side rendering

Outside the browser (Node, SSR and edge runtimes) the cache is inert, the memory tier included:
reads miss and writes store nothing. Server requests therefore never share cached data, and the
same code runs on the server and in the browser.

## Roadmap

1. [M0: Project setup and documentation](https://github.com/rbalukja15/pwa-cache-kit/milestone/1):
   scaffold, CI, ADRs and this README.
2. [M1: Core typed API](https://github.com/rbalukja15/pwa-cache-kit/milestone/2): the typed cache
   API with tier policies and TTLs, the memory tier, and `getOrSet` with stale-while-revalidate.
3. [M2: Three-tier storage](https://github.com/rbalukja15/pwa-cache-kit/milestone/3): the
   SessionStorage and IndexedDB tiers, size budgets and eviction, events, and cross-tab
   invalidation.
4. [M3: Schema migrations](https://github.com/rbalukja15/pwa-cache-kit/milestone/4): versioned
   values migrated on read.
5. [M4: Demo PWA and cache inspector](https://github.com/rbalukja15/pwa-cache-kit/milestone/5): an
   offline ticket wallet that shows which tier served each read.
6. [M5: Benchmarks and decision guide](https://github.com/rbalukja15/pwa-cache-kit/milestone/6):
   read latency per tier and quota behavior across browsers.
7. [M6: Publish and release](https://github.com/rbalukja15/pwa-cache-kit/milestone/7): the npm
   package, a bundle-size budget, the hosted demo and v1.0.

## Design documents

- [Architecture decision records](./docs/adr/README.md)
- [Decision guide](./docs/decision-guide.md) (outline until M5)
- [Development log](./docs/devlog.md)
