# ADR-0001: Three cache tiers (memory, SessionStorage, IndexedDB)

## Status

Accepted

## Date

2026-10-07

## Context

A PWA caches data on the client so it can render quickly and keep working offline. The browser
offers several storage mechanisms, and they differ in latency, capacity, lifetime, scope, API shape
and availability. None of them is fast, durable, shared across tabs and available everywhere at
the same time:

| Property         | Memory (`Map`)                                 | SessionStorage                                                                                | IndexedDB                                                                                             |
| ---------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Relative latency | Lowest: no I/O, no serialization               | Low, but grows with value size (JSON encode and decode on the main thread)                    | Highest per operation: transaction setup, structured clone, disk I/O                                  |
| Capacity         | JS heap; the library sets its own bound        | About 5 MB per origin, browser dependent                                                      | Large, managed by the browser's per-origin storage quota                                              |
| Lifetime         | Until reload or navigation, or worker shutdown | Survives reloads; cleared when the tab closes (session restore may bring it back)             | Persistent until deleted; can be evicted by the browser (see notes)                                   |
| Scope            | One JS realm: a document or a worker           | One origin in one tab; a duplicated tab starts with a copy                                    | One origin, shared by all its tabs, windows and workers                                               |
| API              | Synchronous                                    | Synchronous                                                                                   | Asynchronous                                                                                          |
| Value format     | Any value, held by reference                   | Strings only (this library stores JSON)                                                       | Structured clone                                                                                      |
| Availability     | Everywhere                                     | Window (document) contexts only; not in workers, including service workers (see notes on SSR) | Windows and workers, not SSR; may be unavailable in some private browsing modes and embedded WebViews |

Notes on the table:

- "Relative latency" is an ordering, not a measurement. Real numbers per browser and value size come
  from the benchmarks in issue #17 and are recorded in [`docs/benchmarks.md`](../benchmarks.md).
- IndexedDB does its storage work off the main thread, but structured cloning of values still runs
  on the calling thread.
- SessionStorage and IndexedDB access can also throw when the user or the browser blocks site data,
  for example in some third-party iframe contexts.
- For SessionStorage, "available" means a window (document) context, not just a defined global.
  Node 25 and later expose a working `sessionStorage` global by default, but it is one in-memory
  store for the whole server process, shared by every request and user. It must never back this
  tier during SSR. ADR-0002 defines the exact detection rule.
- IndexedDB data in best-effort storage can be evicted under storage pressure. Safari may also
  delete it, like all script-writable storage, after 7 days of browser use without user interaction
  with the site (web apps added to the Home Screen are not affected in practice). Per-browser
  details go in the [decision guide](../decision-guide.md).

The library has to serve three kinds of data well: hot values that are read often and must not wait
on I/O, per-tab state that should survive a reload but not outlive the tab, and durable data that
must be available offline, across tabs and to the service worker.

## Decision

The cache has three tiers, ordered from fastest to most durable:

1. **Memory**: a `Map` per cache instance, holding values without serialization.
2. **SessionStorage**: per-tab data that should survive a reload and disappear with the tab.
3. **IndexedDB**: durable data shared across tabs, windows and the service worker.

Each key or namespace has a **tier policy** that names which tiers hold it. Examples: memory only
for derived UI state, memory and SessionStorage for a form draft, memory and IndexedDB for API
responses that must work offline. Data is only stored in the tiers its policy names. Reads go
top-down through those tiers and stop at the first hit.

This ADR fixes the set of tiers, the policy model and the top-down read order. The exact cross-tier
semantics are deliberately left to ADR-0002 (issue #6): promotion of lower-tier hits into upper
tiers, the write path and its failure handling, expiry, eviction and capacity limits, and the
behavior when a tier named in a policy is unavailable at runtime.

### Why SessionStorage rather than localStorage

- **Lifetime fits session-scoped data.** Per-tab state such as drafts, filters and wizard progress
  should survive a reload but not linger after the tab closes. SessionStorage clears it when the tab
  closes by default, unless the browser restores the tab or session; localStorage would need the
  library to clean up after itself.
- **Stale copies stay local.** Any per-tab copy of a key that IndexedDB also holds, in memory or in
  SessionStorage, can go stale when another tab or the service worker writes that key. Reads stop
  at the first hit, and SessionStorage fires no `storage` event in other tabs, so ADR-0002 must
  define cross-tab invalidation for the per-tab tiers either way. That staleness is limited to one
  tab and its session. A localStorage tier would instead be a second shared, durable copy next to
  IndexedDB. Writes from several tabs to the two stores are not atomic, so they can drift apart,
  and the drift is visible to every tab and survives browser restarts.
- **IndexedDB already covers the durable role.** It is persistent, cross-tab, asynchronous and has a
  far larger quota. localStorage would duplicate that role with about 5 MB and a synchronous API.

## Consequences

Benefits:

- Applications choose the tier whose lifetime and scope match each kind of data, per key or
  namespace rather than once for the whole app.
- Hot reads are served from memory without I/O or deserialization.
- Per-tab state survives a reload and can be read synchronously at startup, before IndexedDB has
  opened.
- The policy model allows the cache to keep working with fewer tiers when one is missing, for
  example in a service worker, during SSR or in a restricted private browsing mode. ADR-0002 defines
  how.

Costs:

- SessionStorage is synchronous too, so large or frequent reads and writes block the main thread.
  Its quota is small (about 5 MB) and it stores only strings, so every value pays a JSON round trip
  and types such as `Date`, `Map`, `Set` and `BigInt` do not survive it unchanged. The decision
  guide will steer large or rich values away from it.
- Three tiers are more complex than one: more code paths, more ways for tiers to disagree
  (including per-tab copies that go stale when another tab writes) and more to test. The shared
  `TierAdapter` interface and conformance suite (#22) keep per-tier behavior uniform, and ADR-0002
  defines the cross-tier rules in one place.
- Applications have to pick a tier policy. [`docs/decision-guide.md`](../decision-guide.md) is the
  guidance for that choice.
- Three adapters cost bundle size. They stay tree-shakeable so apps that use fewer tiers do not pay
  for the others.

## Alternatives considered

### Single IndexedDB tier with an in-memory front

Simpler, with one durable store. Rejected because:

- It has no home for per-tab data. IndexedDB is shared by all tabs, so per-tab values would need
  tab-scoped keys plus cleanup once the tab is gone, and there is no reliable event for that
  (`beforeunload` and `pagehide` do not always fire, especially on mobile). Such data would linger.
- Per-tab state would have to wait for IndexedDB to open after every reload, instead of being read
  synchronously from SessionStorage.
- Where IndexedDB is unavailable, per-tab state could not survive a reload either.

The tier policy model still allows this layout (memory and IndexedDB) for keys that want it.

### Cache Storage API

Rejected as a value store. It stores `Request`/`Response` pairs keyed by URL, so arbitrary values
must be wrapped in a `Response` and read back by consuming its body, with no structured clone. It is
only exposed in secure contexts and shares the origin quota with IndexedDB, so it adds no capacity.
It remains the right tool for caching HTTP responses in a service worker, which this library does
not try to replace.

### localStorage as the middle tier

Rejected for the reasons in "Why SessionStorage rather than localStorage": it duplicates the
durable, cross-tab role of IndexedDB with a small synchronous string API, adds a second shared,
durable copy that can drift from IndexedDB in a way every tab sees and that survives restarts, and
keeps data after the session ends.
