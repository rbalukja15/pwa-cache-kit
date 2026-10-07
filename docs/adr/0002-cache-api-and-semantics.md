# ADR-0002: Cache API and cross-tier semantics

## Status

Proposed

## Date

2026-10-07

## Context

[ADR-0001](./0001-three-tier-cache.md) fixed the three tiers, the tier policy and top-down reads,
and left the cross-tier semantics to this ADR (#6). The forces:

- IndexedDB is asynchronous and shared by the origin's tabs and workers. Memory and SessionStorage
  copies belong to one context or tab and go stale when another context writes.
- ADR-0001 promises synchronous reads of per-tab state at startup, before IndexedDB has opened.
- Any storage can be missing or throw, a WebKit IndexedDB open can hang, Chromium may report an
  exceeded quota only at commit, and Node 25 has a process-wide `sessionStorage`.
- The design must fit one developer and the effort labels of #7, #9 to #13 and #22 to #25. Harder
  cases go to Known limitations, not to new mechanisms.

This ADR narrows ADR-0001 twice: the policy is per namespace, not per key (section 1), and outside
browser contexts, SSR included, the cache is inert, memory included (section 13).

## Decision

Section 18 names the issues that implement each section. The public types in
`packages/pwa-cache-kit/src` are part of this decision. "Now" is `Date.now()` when a rule applies.

### 1. API shape

- `createCache({ name, tiers, sweepIntervalMs?, broadcast? })` returns a `TieredCache` with
  `name`, `namespace`, `on`, `off`, `status`, `clear` and `close`. `tiers` holds the opaque results
  of `memoryTier(opts?)`, `sessionTier(opts?)` and `indexedDBTier(opts?)`, each carrying an internal
  function that creates its adapter for one cache (section 17), so the adapters of factories an app
  never calls are tree-shaken.
- `cache.namespace<V>(name, { tiers, ttlMs?, staleWhileRevalidateMs?, version?, migrations? })`
  returns a `CacheNamespace<V>` with `name`, `get`, `getSync`, `has`, `set`, `delete`, `keys`,
  `clear` and `getOrSet` (signatures in `types.ts`). Policy, expiry defaults and version are per
  namespace; a key that needs its own policy uses its own namespace. Handles with the same name
  share entries, but each applies its own options, so the options should match.
- Names match `/^[A-Za-z0-9_.-]{1,64}$/`; keys are any string. `createCache` and `namespace()` throw
  `TypeError` for an invalid name, a `tiers` entry no tier factory made, empty or duplicate `tiers`,
  a policy tier the cache was not created with, or an invalid number (sections 6, 8, 13 and 14).
- `has(key)` runs `get(key)` and resolves whether it found a value. `keys()` resolves the distinct
  keys in the available policy tiers, unordered and without expiry checks.
- `close()` is idempotent and marks the cache closed at once: later data calls reject with `CLOSED`
  (`getSync` throws it). It stops the sweep, closes the channel, removes its page listeners and
  drops memory entries. IndexedDB steps already queued still run, then the connection closes and is
  never reopened. Reads in flight promote and write back nothing; loads in flight are not stored.
- `CacheEntry<V>` is an entry's read view, exported for tooling; no method returns it yet.

### 2. Async-first

All data methods but `getSync` return Promises and never throw synchronously: bad arguments (a
non-string key, an `undefined` value, invalid options, a non-function loader) reject with
`TypeError`. The one synchronous read, `getSync(key)`, throws that `TypeError` instead, walks
memory then session by the rules of section 3 and never touches IndexedDB, which keeps ADR-0001's
promise of synchronous startup reads.

### 3. Read path

`get` walks the namespace's available policy tiers in the order memory, session, indexeddb. In each
tier, the first row that matches what the tier holds for the key applies:

| The tier holds                        | Then                                      | Events                                                             |
| ------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| nothing                               | next tier                                 | `miss` absent                                                      |
| an unreadable entry (the read throws) | next tier                                 | `error` STORAGE_FAILED, `miss` error                               |
| an entry with `format > 1`            | leave it, next tier                       | `miss` newer                                                       |
| a corrupt entry (section 14)          | remove it, next tier                      | `error` CORRUPT_ENTRY, `miss` invalid                              |
| an expired entry (`now >= expiresAt`) | remove it, next tier                      | `expire`, `miss` expired                                           |
| `schemaVersion > version`             | leave it, next tier                       | `miss` newer                                                       |
| `schemaVersion < version`             | migrate (section 14), then the rows below | `set` migrate; on failure `error` MIGRATION_FAILED, `miss` invalid |
| a stale entry (`now >= freshUntil`)   | next tier; `getOrSet` keeps the first one | `miss` stale                                                       |
| a fresh entry                         | stop, return its value                    | `hit`                                                              |

After a fresh hit, the entry is copied into each available policy tier above it (promotion) with the
same value, `schemaVersion`, `freshUntil`, `expiresAt` and `sizeBytes` and a new `updatedAt`, so
reads never extend expiry. Promotion is best effort and never changes the result: an entry above
the target's `maxEntryBytes` is skipped, a failure emits `error`, and a detached read (section 15)
promotes nothing. Each walked tier emits its other events first, then one `hit` or `miss`; one
`promote` event (with `from`) per target follows the `hit`.

### 4. Write path

`set(key, value, options?)` validates its arguments and computes `freshUntil`, `expiresAt` and
`sizeBytes` once. With session in the policy it first runs `JSON.stringify` on the value to check
and size it; a throw or an `undefined` result rejects with `TypeError` before any tier is touched.
It then writes through to every available policy tier, top-down: memory and session synchronously
during the call (as `delete` and `clear` do too, so `void ns.set(k, v); ns.getSync(k)` returns
`v`), then IndexedDB in one readwrite transaction on the key's queue (section 15), awaited to
`complete`.

- A tier that fails (`ENTRY_TOO_LARGE`, `QUOTA_EXCEEDED`, `SERIALIZATION_FAILED` for a
  `DataCloneError`, `STORAGE_FAILED`) has its existing copy deleted, best effort, so it cannot serve
  an older value; the error is emitted and collected. Unavailable tiers are skipped silently.
- `set` resolves `{ stored: TierName[], errors: CacheError[] }` and rejects with `CacheWriteError`
  only when `stored` is empty and `errors` is not. With no usable tier (inert, or a session-only
  policy in a worker) it resolves `{ stored: [], errors: [] }`.
- `delete(key)` removes the key from every available policy tier (`delete` reason delete per tier).
  `namespace.clear()` removes the namespace from every available configured tier, policy or not, and
  `cache.clear()` removes all of the cache's entries from every available configured tier (`clear`
  per tier). If a tier fails, the others still run and the call rejects with `CacheWriteError`.
- The library touches only its own session keys (prefix `pwa-cache-kit:<cache>:`) and database.
- Invariant: within one context, after an operation on a key settles, a read returns what it left
  (a miss after a delete), a newer value or a miss, never an older value, unless a removal failed
  in a tier (a `delete`, a `clear`, or a failed write's cleanup delete).

### 5. Values

| Policy                    | Accepted values                                                             | Runtime check                                |
| ------------------------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| memory only               | anything except `undefined`, held by reference                              | none                                         |
| indexeddb without session | structured-cloneable                                                        | `DataCloneError`: SERIALIZATION_FAILED there |
| includes session          | JSON-safe: `null`, booleans, finite numbers, strings, arrays, plain objects | `JSON.stringify` failure: `TypeError`        |

There is no deep validation, so a value can read back differently per tier: one outside its row
that passes the check changes (a `Date` or `NaN` with session in the policy), and IndexedDB drops
class prototypes. Treat every value passed to `set` as immutable: memory keeps the reference, and
IndexedDB clones the value only when its queued step runs. `undefined` is never stored and always
means a miss; `null` is a value. `CacheValue` excludes only `undefined`; compile-time policy checks
are a possible later improvement.

### 6. Sizes and budgets

- `sizeBytes` is computed once per write. With session in the policy it is twice the length of the
  value's JSON text. Otherwise it is an estimate: strings twice their length, other primitives 8,
  an `ArrayBuffer` its `byteLength`, a view its buffer's `byteLength` (structured clone copies the
  whole buffer), `Blob` its `size`, arrays, objects, `Map` and `Set` their members (and keys) plus 8
  per member, and 8 for an object already counted (cycles).
- Each tier has per-cache `maxBytes` (memory 8 MiB, session 2 MiB, indexeddb 64 MiB) and
  `maxEntryBytes` (`maxBytes / 4`) from its factory options: positive finite numbers with
  `maxEntryBytes <= maxBytes`, else `TypeError`. Usage is the sum of the cache's `sizeBytes` there.
- An entry above `maxEntryBytes` is not stored in that tier: `ENTRY_TOO_LARGE` for a write, skipped
  for a promotion. Exceeding `maxBytes` evicts (section 7) and never rejects. The IndexedDB budget
  is soft, since several contexts write to it, and the sweep enforces it.

### 7. Eviction

- Order: expired entries first, then least recently used. Memory uses exact LRU (`Map` re-insertion
  on hit, write and promotion). Session and IndexedDB use least recently written: `updatedAt`, set
  by writes and promotions only, so a hit never writes just to refresh recency.
- Memory and session evict synchronously in the write that exceeds `maxBytes`, down to `maxBytes`,
  sparing the entry being written; IndexedDB does the same in its sweep. Each removal emits `expire`
  or `evict` reason budget.
- A quota error is a `DOMException` named `QuotaExceededError` or `NS_ERROR_DOM_QUOTA_REACHED` or
  with legacy code 22 or 1014, and in IndexedDB also a transaction that aborts with one at commit.
  The tier then evicts in the same order (`evict` reason quota) until the entry's `sizeBytes` is
  freed and retries once; a second quota error is `QUOTA_EXCEEDED`.

### 8. Expiry

- `ttlMs` (default `Infinity`) and `staleWhileRevalidateMs` (default 0) are namespace defaults that
  `set` options override. `ttlMs` must be positive and `staleWhileRevalidateMs` non-negative, or
  `Infinity`; anything else (`NaN` included) is a `TypeError`.
- At write, `freshUntil = now + ttlMs` and `expiresAt = freshUntil + staleWhileRevalidateMs`, each
  stored as absent when infinite (absent compares as `Infinity`). An entry is fresh while
  `now < freshUntil`, stale until `expiresAt`, then expired. There is no sliding expiry.
- Reads remove the expired entries they find. The IndexedDB tier also sweeps its `expiresAt` index
  after opening and every `sweepIntervalMs` (default 300000; 0 disables the timer; else an integer
  from 1 to 2^31 - 1), emitting `expire`, and then enforces its budget.

### 9. getOrSet

`getOrSet(key, loader, options?)` reads as `get`. Fresh: it resolves the value. Stale: it resolves
the first stale value and starts one background revalidation per key. Miss: it calls `loader()`;
concurrent calls for the key on this instance join that load. A load's result is validated and
stored as by `set` (`set` reason load); callers get it once memory and session hold it, without
waiting for IndexedDB, and storage failures are only emitted. A rejecting or throwing loader
rejects every joined caller with its error and caches nothing; in the background, a failure or an
`undefined` result emits `LOADER_FAILED` and keeps the stale entry. Loads can be detached (section
15). Offline-first recipe: `ttlMs: 5 * 60_000, staleWhileRevalidateMs: Infinity`.

### 10. Errors

- Misses are `undefined`. `get`, `getSync`, `has` and `keys` never reject or throw for storage
  reasons: a failing tier is emitted and counts as a miss. Caller bugs are `TypeError`s.
- `CacheError extends Error` has an explicit `name`, a `code` and optional `tier`, `namespace`,
  `key` and `cause`. `CacheWriteError extends CacheError` has code `WRITE_FAILED` and a frozen
  `errors: readonly CacheError[]` of the tier failures.
- Codes: `QUOTA_EXCEEDED` (after the retry), `ENTRY_TOO_LARGE`, `SERIALIZATION_FAILED`
  (`DataCloneError`, or JSON on promotion or write-back), `STORAGE_FAILED` (any other storage
  exception), `TIER_UNAVAILABLE`, `CORRUPT_ENTRY` and `MIGRATION_FAILED` (copy removed),
  `LOADER_FAILED` (background load, stale entry kept) and `CLOSED` (after `close()`).
- Every tier error is emitted once as an `error` event; `CLOSED` and `WRITE_FAILED` never are.
  Without listeners failures are silent, so the README recommends a listener during development.

### 11. Events

`on(type, handler)` returns an unsubscribe function and `off(type, handler)` removes a handler.
Payloads (`CacheEvent`) are `{ type, namespace, key?, tier?, ... }` with these extras:

| Type      | Extras                                                                 | Emitted when a tier                    |
| --------- | ---------------------------------------------------------------------- | -------------------------------------- |
| `hit`     | `sizeBytes`, `freshUntil?`, `expiresAt?`                               | serves a fresh value                   |
| `miss`    | `reason`: absent, stale, expired, newer, invalid, error                | walked by a read does not              |
| `set`     | `sizeBytes`, `freshUntil?`, `expiresAt?`, `reason`: set, load, migrate | stores a value                         |
| `promote` | `from`, `sizeBytes`, `freshUntil?`, `expiresAt?`                       | receives a lower tier's hit            |
| `delete`  | `reason`: delete, remote                                               | is told to remove a key                |
| `clear`   | `reason`: clear, remote; no `namespace` for the whole cache            | is told to clear a namespace or cache  |
| `expire`  |                                                                        | removes an expired entry               |
| `evict`   | `sizeBytes`, `reason`: budget, quota                                   | removes a live entry to make room      |
| `error`   | `error`; `namespace`, `key` and `tier` when known                      | fails, or when a background load fails |

Dispatch is synchronous: events follow the order of effects, and handlers run in registration order,
each registered at most once per type. No payload is allocated for a type without listeners. A
throwing handler is reported via `globalThis.reportError` (else rethrown from a `setTimeout`)
without breaking the operation. The inspector (#16) derives TTL remaining from `freshUntil` and
`expiresAt`. `delete` and `clear` are emitted for each tier a call or message covers, whether or not
it held anything, so no tier is read first. A copy removed after a failed write, a corrupt read or
a failed migration is signalled by its `error` event only.

### 12. Consistency across contexts

- Namespaces whose policy includes indexeddb are shared: IndexedDB is their source of truth, and
  memory (per context) and session (per tab) hold copies of it. Other namespaces are not shared.
- Within a context: per-key call order and read-your-writes. Across contexts: the last IndexedDB
  commit wins, with no atomic read-modify-write and no `getOrSet` deduplication.
- After a successful IndexedDB `set` (not a migration write-back), `delete` (a failed write's
  cleanup delete included) or `clear` of a shared namespace or of the whole cache, the cache posts a
  value-free message on `BroadcastChannel('pwa-cache-kit:<cache>')`: `{ v: 1, op, ns?, key? }` with
  `op` one of `'set'`, `'delete'` and `'clear'`. Receivers drop that key, namespace or (without
  `ns`) every namespace, per-context ones included, from memory and session and emit `delete` or
  `clear` reason remote. A message they do not recognize drops every memory and session copy of the
  shared namespaces opened in their context, emitting `clear` reason remote per namespace and tier.
- In a window, `pagehide` with `persisted` closes the channel, and nothing is posted while it is
  closed. `pageshow` with `persisted` reopens it and drops the shared copies as for an unknown
  message: messages were missed while the page was in the back/forward cache, and Chromium evicts a
  cached page whose open channel gets one.
- The channel is opened only in a browser context whose cache has an indexeddb tier. Without
  `BroadcastChannel`, or with `broadcast: false`, staleness is bounded by the TTL.

### 13. Environments

- A browser context is a window (`window` is an object with a `document` object) or a worker
  (`importScripts` is a function, only inspected). Elsewhere (Node, SSR, edge) the cache is inert:
  all tiers are unavailable, reads miss, `set` resolves `{ stored: [], errors: [] }`, `delete` and
  `clear` resolve, and `getOrSet` calls the loader every time without deduplication, so server
  requests never share data. An inert cache opens nothing (no database, channel, page listeners or
  timer) and emits no events.
- Memory is available in every browser context, session only in a window where reading
  `window.sessionStorage` in try/catch returns a non-null object (the bare or `globalThis`
  `sessionStorage` is never read). Workers have memory and indexeddb.
- IndexedDB is unavailable unless reading `globalThis.indexedDB` in try/catch returns a non-null
  object. Then `createCache` starts opening database `pwa-cache-kit:<cache>` (version 1), and
  operations wait for it. If the open fails or does not succeed within `indexedDBTier`'s
  `openTimeoutMs` (an integer from 1 to 2^31 - 1, default 3000), as with WebKit opens that never
  settle, the tier is unavailable for the cache's life and a late connection is closed. At version
  1 the open never gets `blocked`; one queued behind another context's `deleteDatabase` is bounded
  by `openTimeoutMs`. On `versionchange` the connection is closed, so it never blocks another
  context. The operation that finds a connection lost (`versionchange`, a `close` event,
  `InvalidStateError`) makes one reopen attempt, waits for it as for the open and then runs on the
  new connection; if the attempt fails, the tier is unavailable for the cache's life.
- Unavailable tiers are skipped, and no tier outside the policy substitutes for them. `status()`
  reports each configured tier as pending, available or unavailable. A tier that turns unavailable
  after being pending or available emits `TIER_UNAVAILABLE` once, never synchronously inside
  `createCache`; one unavailable from the start (session in a worker, no `indexedDB`) only shows in
  `status()`.

### 14. Entry format and migrations

- Every tier stores one envelope: `format` (1), `value`, `schemaVersion`, `updatedAt`,
  `freshUntil?`, `expiresAt?` and `sizeBytes`. Memory: one `Map` per cache, keyed by namespace and
  key joined with `'\u0000'`. Session: key `pwa-cache-kit:<cache>:<ns>:<key>` (names exclude `:`, so
  the first three colons split it), value the envelope's JSON. IndexedDB: store `entries` of the
  envelope plus `ns` and `key`, with keyPath `['ns', 'key']`, an `expiresAt` index and an
  `updatedAt` index on `['updatedAt', 'sizeBytes']`, so the sweep finds the oldest entries and sums
  usage from index keys alone; a namespace is the key range `IDBKeyRange.bound([ns], [ns, []])`.
- An entry with `format > 1` is a miss, left alone. Any other entry that is unparseable or not a
  valid format-1 envelope is `CORRUPT_ENTRY` and is removed.
- `version` is an integer from 1 (default 1); `migrations[n]` maps a version-n value to version
  n + 1 synchronously, so `getSync` can migrate. A read migrates an older entry step by step, serves
  it with its original expiry and writes it back to its tier (`set` reason migrate; for IndexedDB in
  the read's queue step, unless detached). The write-back recomputes `sizeBytes` (and the JSON for
  session) and fails like a promotion, without changing the result. A missing or throwing step or
  an `undefined` result deletes that copy and emits `MIGRATION_FAILED`, and the walk continues.

### 15. Concurrency

- Within one instance, IndexedDB steps run on a per-key promise chain in call order, after the
  call's memory and session effects (section 4). A `clear()` runs after the steps queued on its
  keys and before later ones; `keys()` waits for the steps queued in its namespace. Nothing is
  ordered across keys or contexts beyond IndexedDB itself.
- A local `set`, `delete` or `clear` of a key detaches the reads and loads in flight for it, and a
  remote message for it detaches its reads. A detached read skips promotion and write-back; a
  detached load is returned but not stored. A per-key counter is enough to detect this.

### 16. Package format

ESM only (no CommonJS build), `sideEffects: false`, no runtime dependencies, and no storage, channel
or timer access at import time: all of it starts in `createCache`.

### 17. Tier adapter contract

The orchestrator reaches tiers only through `TierAdapter<Sync extends boolean>`: `name`, `sync`,
`status`, `get(ns, key)`, `set(ns, key, envelope)`, `delete(ns, key)`, `clear(ns?)`, `keys(ns)`,
`sweep?()` and `close()`. With `sync: true` (memory, session) the methods return directly, which
keeps `getSync` possible; with `sync: false` (indexeddb) they return Promises. A tier factory's
result carries an internal `create(cacheName, emit)` that builds the adapter for one cache. Adapters
own budgets, eviction and quota handling and emit `evict` and `expire` for their own removals.
Failures are `CacheError`s; `get` removes a corrupt entry before failing with `CORRUPT_ENTRY` and
never treats `format > 1` as corrupt. `get` returns an entry whatever its expiry: on a read the
orchestrator applies section 3, removing an expired copy with `delete` and emitting `expire`.
Adapters act on expiry only in eviction and the sweep, which the conformance suite's TTL cases test.

### 18. Ownership

| Issue | Implements                                                                               |
| ----- | ---------------------------------------------------------------------------------------- |
| #7    | `createCache`, `TieredCache`, `CacheNamespace`: sections 1 to 5, 8 (on read), 10, 13, 15 |
| #9    | the memory adapter and the size estimate (sections 6 and 14)                             |
| #10   | the session adapter: encoding, key prefix, availability, quota errors (sections 13, 14)  |
| #11   | the IndexedDB adapter: schema, open, timeout, reopen and sweep (sections 8, 13 and 14)   |
| #12   | budgets, eviction and the quota path (sections 6 and 7)                                  |
| #13   | migrations (section 14)                                                                  |
| #19   | the package format (section 16)                                                          |
| #22   | the adapter contract and its conformance suite (section 17)                              |
| #23   | event dispatch (section 11)                                                              |
| #24   | the channel, its messages and back/forward cache handling (section 12)                   |
| #25   | `getOrSet` (section 9)                                                                   |

## Consequences

- One async API covers every tier, and `getSync` keeps synchronous reads at startup.
- Tier failures are reported in `SetResult.errors` and `error` events; the inert mode makes SSR
  safe.
- Costs: with IndexedDB in the policy, `set` waits for the transaction. A partial write resolves, so
  callers that need durability check `stored` or listen for `error`. Session namespaces accept only
  JSON-safe values and pay JSON encoding on every write. Sizes are estimates, and the IndexedDB
  budget is soft.
- The `navigator.storage.estimate()` pre-check and the `persist` option listed in #12 are not part
  of this design; quota errors are handled when they occur (section 7).

## Known limitations

- iOS Safari can lose IndexedDB connections that affected WebKit versions cannot reopen before a
  reload, so the tier stays unavailable for that page.
- While IndexedDB is unavailable, writes, deletes and clears skip it, so entries they meant to
  replace or remove can reappear after a reload.
- Safari may delete script-writable storage after 7 days of use without interaction with the site,
  and browsers may evict best-effort storage under pressure.
- Chromium may report exhausted quota only at commit, and deleting IndexedDB records may not lower
  usage at once (compaction), so the quota retry can fail again with `QUOTA_EXCEEDED`.
- Other contexts' copies stay stale until a message arrives, or until expiry without
  `BroadcastChannel`.
- Session copies of shared namespaces miss messages sent while their page is not running (reload,
  tab discard), and writes that commit after `pagehide` or `close()` are not broadcast.
- There is no cross-context atomicity and no cross-context `getOrSet` deduplication.
- In IndexedDB, a read's removal of an expired or corrupt copy, or its migration write-back, can
  delete or overwrite a value another context committed after the read.
- An IndexedDB record the browser cannot read (such as Chromium's `NotReadableError`) stays, and
  every read of it misses with `STORAGE_FAILED` until a `set` overwrites it.
- Values are not checked against the policy at compile time, and memory values are references.

## Alternatives considered

- A synchronous API over the upper tiers only: rejected; IndexedDB is asynchronous, and `getSync`
  covers startup reads.
- Writing only the top tier and copying down later: rejected; a reload or crash would lose writes.
- Rejecting writes over budget: rejected; a cache should make room instead.
- Per-key policies: rejected; a namespace keeps policy, expiry and version with one kind of data.
- Sending values over `BroadcastChannel`: rejected; IndexedDB already holds them.
- Dual ESM and CommonJS builds: rejected; the consumers are browser bundlers, which use ESM.
- A stricter design with cross-tab reconcile and compile-time value gates was considered and
  deferred: too much machinery for the guarantees it adds at this stage.
