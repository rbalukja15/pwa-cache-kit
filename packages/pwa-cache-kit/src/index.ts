// Public API, designed in ADR-0002. indexedDBTier lands in #11.
export { createCache } from './cache.js';
export { memoryTier } from './memory.js';
export { sessionTier } from './session.js';
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
