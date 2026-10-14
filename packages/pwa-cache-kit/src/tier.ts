// Internal tier adapter contract (ADR-0002 section 17). Not exported from index.ts.
import type { CacheEvent } from './events.js';
import type { CacheValue, TierName, TierOptions, TierStatus } from './types.js';

/**
 * What every tier stores for a key (ADR-0002 section 14). Times are ms since the epoch; an absent
 * `freshUntil` or `expiresAt` means never, and `Infinity` is never stored.
 */
export interface Envelope {
  readonly format: 1;
  readonly value: CacheValue;
  /** Schema version of `value`, an integer from 1. */
  readonly schemaVersion: number;
  /** When this copy was written to its tier, by a write or a promotion. */
  readonly updatedAt: number;
  readonly freshUntil?: number;
  readonly expiresAt?: number;
  /** Size estimate computed once per write by the orchestrator. Adapters account with it as is. */
  readonly sizeBytes: number;
}

/** A sync adapter returns `T`, an async one `Promise<T>`. */
export type TierResult<Sync extends boolean, T> = Sync extends true ? T : Promise<T>;

/** The events adapters emit for their own removals and state changes. */
export type TierEvent = Extract<CacheEvent, { type: 'expire' | 'evict' | 'error' }>;

/** Reports an adapter's events to the cache's handlers. */
export type TierEmit = (event: TierEvent) => void;

/**
 * The only way the orchestrator reaches a tier (ADR-0002 section 17).
 *
 * - With `sync: true` (memory, session) every method returns directly and throws on failure, which
 *   keeps `getSync` possible. With `sync: false` (indexeddb) every method returns a Promise and
 *   rejects on failure, never throwing synchronously.
 * - Failures are `CacheError`s with `tier`, and with `namespace` and `key` when there is one.
 *   Adapters do not emit the errors they throw or reject with; the orchestrator emits them.
 * - Adapters own their budget, eviction and quota handling (sections 6 and 7) and emit `expire`
 *   and `evict` for the entries they remove on their own. They act on expiry only there and in
 *   `sweep`: `get` and `keys` return entries whatever their expiry.
 */
export interface TierAdapter<Sync extends boolean = boolean> {
  readonly name: TierName;
  readonly sync: Sync;
  /** `pending` until an async tier has opened; `unavailable` for the rest of the cache's life. */
  readonly status: TierStatus;
  /**
   * The key's envelope; `'newer'` for a record of a later format, which is left in place; else
   * undefined. A record that is not a valid envelope is removed, then fails with `CORRUPT_ENTRY`.
   */
  get(ns: string, key: string): TierResult<Sync, Envelope | 'newer' | undefined>;
  /**
   * Stores the envelope, replacing the key's previous one, and evicts when over budget. Fails
   * with `ENTRY_TOO_LARGE` above `maxEntryBytes` (changing nothing), `QUOTA_EXCEEDED` after the
   * quota retry, `SERIALIZATION_FAILED` or `STORAGE_FAILED`.
   */
  set(ns: string, key: string, envelope: Envelope): TierResult<Sync, void>;
  /** Removes the key; a missing key is not an error. */
  delete(ns: string, key: string): TierResult<Sync, void>;
  /** Removes one namespace of this cache, or every namespace without `ns`. */
  clear(ns?: string): TierResult<Sync, void>;
  /** The namespace's keys, unordered, expired ones included. */
  keys(ns: string): TierResult<Sync, string[]>;
  /** Removes expired entries (emitting `expire`), then enforces the budget. */
  sweep?(): TierResult<Sync, void>;
  /** Releases the tier's resources. Idempotent. */
  close(): void;
}

/** Builds the adapter of one tier for one cache; tier factory results carry one (section 17). */
export type CreateTierAdapter<Sync extends boolean = boolean> = (
  cacheName: string,
  emit: TierEmit,
) => TierAdapter<Sync>;

/** A tier's budget for one cache, in estimated bytes (ADR-0002 section 6). */
export interface TierBudget {
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
}

const MiB = 1024 * 1024;
const defaultMaxBytes: Readonly<Record<TierName, number>> = {
  memory: 8 * MiB,
  session: 2 * MiB,
  indexeddb: 64 * MiB,
};

/**
 * Resolves a tier factory's budget options: `maxBytes` defaults per tier and `maxEntryBytes` to a
 * quarter of it.
 * @throws {TypeError} unless both are positive finite numbers and `maxEntryBytes <= maxBytes`.
 */
export function tierBudget(tier: TierName, options: TierOptions = {}): TierBudget {
  const maxBytes = options.maxBytes ?? defaultMaxBytes[tier];
  const maxEntryBytes = options.maxEntryBytes ?? maxBytes / 4;
  if (!isPositiveFinite(maxBytes) || !isPositiveFinite(maxEntryBytes) || maxEntryBytes > maxBytes) {
    throw new TypeError(
      `${tier} tier: maxBytes and maxEntryBytes must be positive finite numbers with ` +
        `maxEntryBytes <= maxBytes (got ${String(maxBytes)} and ${String(maxEntryBytes)})`,
    );
  }
  return { maxBytes, maxEntryBytes };
}

/**
 * Whether a storage exception means the quota is exhausted: a `DOMException` named
 * `QuotaExceededError` or `NS_ERROR_DOM_QUOTA_REACHED`, or with legacy code 22 or 1014 (section 7).
 */
export function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014
  );
}

/**
 * Checks a record read back from storage: an `Envelope` if it is a valid format-1 envelope,
 * `'newer'` if a later library version wrote it, else `'corrupt'`.
 */
export function readEnvelope(record: unknown): Envelope | 'newer' | 'corrupt' {
  if (typeof record !== 'object' || record === null) return 'corrupt';
  const { format } = record as { format?: unknown };
  if (typeof format === 'number' && Number.isInteger(format) && format > 1) return 'newer';
  if (format !== 1) return 'corrupt';
  const entry = record as Partial<Record<keyof Envelope, unknown>>;
  const valid =
    entry.value !== undefined &&
    typeof entry.schemaVersion === 'number' &&
    Number.isInteger(entry.schemaVersion) &&
    entry.schemaVersion >= 1 &&
    isTime(entry.updatedAt) &&
    (entry.freshUntil === undefined || isTime(entry.freshUntil)) &&
    (entry.expiresAt === undefined || isTime(entry.expiresAt)) &&
    typeof entry.sizeBytes === 'number' &&
    Number.isFinite(entry.sizeBytes) &&
    entry.sizeBytes >= 0;
  return valid ? (record as Envelope) : 'corrupt';
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
