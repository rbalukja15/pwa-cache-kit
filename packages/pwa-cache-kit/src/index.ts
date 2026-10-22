// Public API, designed in ADR-0002. sessionTier lands in #10.
export { createCache } from './cache.js';
export { indexedDBTier } from './indexeddb.js';
export { memoryTier } from './memory.js';
export { CacheError, CacheWriteError } from './errors.js';
export type { CacheErrorCode, CacheErrorOptions } from './errors.js';
export type { CacheEvent, CacheEventHandler, CacheEventType } from './events.js';
export type {
  CacheEntry,
  CacheNamespace,
  CacheOptions,
  CacheValue,
  CreateCache,
  IndexedDBTierOptions,
  NamespaceOptions,
  SetOptions,
  SetResult,
  TierConfig,
  TierFactory,
  TierName,
  TierOptions,
  TierPolicy,
  TierStatus,
  TieredCache,
} from './types.js';
