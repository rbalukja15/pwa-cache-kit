// Public API, designed in ADR-0002. createCache and the tier factories land in #7 onwards.
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
