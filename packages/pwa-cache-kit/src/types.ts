import type { CacheError } from './errors.js';
import type { CacheEventHandler, CacheEventType } from './events.js';

/** A cache tier, from fastest to most durable (ADR-0001). */
export type TierName = 'memory' | 'session' | 'indexeddb';

/**
 * The tiers that hold a namespace's data: non-empty, no duplicates. Array order is ignored; reads
 * always go memory, session, indexeddb.
 */
export type TierPolicy = readonly TierName[];

/** Any value except `undefined`, which always means a miss. Policy limits: ADR-0002 section 5. */
export type CacheValue = string | number | boolean | bigint | symbol | object | null;

/** State of a configured tier, as reported by `TieredCache.status()`. */
export type TierStatus = 'pending' | 'available' | 'unavailable';

/** Budget options of every tier factory, in estimated bytes (ADR-0002 section 6). */
export interface TierOptions {
  /** This cache's budget in the tier. Default: memory 8 MiB, session 2 MiB, indexeddb 64 MiB. */
  readonly maxBytes?: number;
  /** Largest entry the tier stores. Default `maxBytes / 4`. */
  readonly maxEntryBytes?: number;
}

/** Options of `indexedDBTier`. */
export interface IndexedDBTierOptions extends TierOptions {
  /** Time to open or reopen the database: an integer from 1 to 2^31 - 1 ms. Default 3000. */
  readonly openTimeoutMs?: number;
}

// Type-only brand for now: #7 replaces it with a real, non-exported `Symbol` whose property holds
// the factory's `create(cacheName, emit)`, so factories need no cast.
declare const tierBrand: unique symbol;

/** An opaque tier description: only `memoryTier`, `sessionTier` and `indexedDBTier` create one. */
export interface TierConfig<N extends TierName = TierName> {
  readonly name: N;
  /** Internal: set by the tier factory and read by `createCache` (ADR-0002 section 17). */
  readonly [tierBrand]: unknown;
}

/** Signature of `memoryTier`, `sessionTier` and `indexedDBTier`. */
export type TierFactory<N extends TierName, O extends TierOptions = TierOptions> = (
  options?: O,
) => TierConfig<N>;

/** Options of `createCache`. */
export interface CacheOptions {
  /** Matches `/^[A-Za-z0-9_.-]{1,64}$/`; names the database, storage key prefix and channel. */
  readonly name: string;
  /** The tiers the cache may use, at least one and at most one of each. */
  readonly tiers: readonly TierConfig[];
  /** IndexedDB sweep period: 0 (no timer) or an integer from 1 to 2^31 - 1 ms. Default 300000. */
  readonly sweepIntervalMs?: number;
  /** Invalidate other contexts' copies over `BroadcastChannel`. Default true. */
  readonly broadcast?: boolean;
}

/** Expiry of a write (ADR-0002 section 8). */
export interface SetOptions {
  /** How long the value is fresh, in ms: positive or `Infinity`. Default `Infinity`. */
  readonly ttlMs?: number;
  /**
   * How long it stays usable as stale after that: non-negative or `Infinity`. Default 0.
   * Only `getOrSet` serves stale values; `get`, `getSync` and `has` treat them as misses.
   */
  readonly staleWhileRevalidateMs?: number;
}

/** Options of `TieredCache.namespace()`: tier policy, default expiry and schema version. */
export interface NamespaceOptions extends SetOptions {
  readonly tiers: TierPolicy;
  /** Schema version of the values, an integer from 1. Default 1. */
  readonly version?: number;
  /** `migrations[n]` turns a version-n value into a version n + 1 value, synchronously. */
  readonly migrations?: Readonly<Record<number, (value: unknown) => unknown>>;
}

/** Outcome of `set`: the tiers that stored the value and the per-tier failures. */
export interface SetResult {
  readonly stored: readonly TierName[];
  readonly errors: readonly CacheError[];
}

/** Read view of a stored entry; times are ms since the epoch. */
export interface CacheEntry<V extends CacheValue = CacheValue> {
  readonly value: V;
  /** When this copy was last written to its tier. */
  readonly updatedAt: number;
  /** Absent: fresh forever. */
  readonly freshUntil?: number;
  /** Absent: never expires. */
  readonly expiresAt?: number;
  readonly stale: boolean;
  readonly tier: TierName;
}

/** Typed access to one namespace's entries. */
export interface CacheNamespace<V extends CacheValue> {
  readonly name: string;
  /** The first fresh value in the policy tiers, else undefined. */
  get(key: string): Promise<V | undefined>;
  /**
   * Like `get` over memory and session only; never touches IndexedDB.
   * @throws {TypeError} for a non-string key.
   * @throws {CacheError} with code `CLOSED` after `close()`.
   */
  getSync(key: string): V | undefined;
  /** Whether `get` finds a value. */
  has(key: string): Promise<boolean>;
  /** Writes through to every available policy tier. */
  set(key: string, value: V, options?: SetOptions): Promise<SetResult>;
  /** Removes the key from every available policy tier. */
  delete(key: string): Promise<void>;
  /** Keys held by the policy tiers, unordered and without an expiry check. */
  keys(): Promise<string[]>;
  /** Removes the namespace from every available configured tier. */
  clear(): Promise<void>;
  /** A fresh value; else a stale one plus a background reload; else the loader's stored result. */
  getOrSet(key: string, loader: () => V | Promise<V>, options?: SetOptions): Promise<V>;
}

/** A cache instance, as returned by `createCache`. */
export interface TieredCache {
  readonly name: string;
  /** A handle on a namespace; handles with the same name share its entries. */
  namespace<V extends CacheValue = CacheValue>(
    name: string,
    options: NamespaceOptions,
  ): CacheNamespace<V>;
  /** Adds a handler and returns a function that removes it. */
  on<T extends CacheEventType>(type: T, handler: CacheEventHandler<T>): () => void;
  /** Removes a handler. */
  off<T extends CacheEventType>(type: T, handler: CacheEventHandler<T>): void;
  /** State of each configured tier. */
  status(): Partial<Record<TierName, TierStatus>>;
  /** Removes every entry of this cache from every available configured tier. */
  clear(): Promise<void>;
  /** Later data calls fail with `CLOSED`; queued IndexedDB steps run, then the database closes. */
  close(): void;
}

/** Signature of `createCache`. */
export type CreateCache = (options: CacheOptions) => TieredCache;
