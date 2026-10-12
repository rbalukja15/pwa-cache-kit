import type { TierName } from './types.js';

/**
 * Why a cache operation failed (ADR-0002 section 10). Only `CacheWriteError` uses `WRITE_FAILED`:
 * narrow with `instanceof CacheWriteError`, not by code, to read its `errors`.
 */
export type CacheErrorCode =
  | 'QUOTA_EXCEEDED'
  | 'ENTRY_TOO_LARGE'
  | 'SERIALIZATION_FAILED'
  | 'STORAGE_FAILED'
  | 'TIER_UNAVAILABLE'
  | 'CORRUPT_ENTRY'
  | 'MIGRATION_FAILED'
  | 'LOADER_FAILED'
  | 'CLOSED'
  | 'WRITE_FAILED';

/** Context of a `CacheError`: its `cause` (such as a `DOMException`) and where it failed. */
export interface CacheErrorOptions {
  readonly cause?: unknown;
  readonly tier?: TierName;
  readonly namespace?: string;
  readonly key?: string;
}

/** A storage, loader or lifecycle failure reported by the cache; `code` says which. */
export class CacheError extends Error {
  // Set explicitly so the name survives minification.
  override readonly name: string = 'CacheError';
  /** What went wrong. */
  readonly code: CacheErrorCode;
  /** Tier where the failure happened, if it is tied to one. */
  readonly tier: TierName | undefined;
  /** Namespace of the failed operation, if any. */
  readonly namespace: string | undefined;
  /** Key of the failed operation, if any. */
  readonly key: string | undefined;

  constructor(code: CacheErrorCode, message: string, options: CacheErrorOptions = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.code = code;
    this.tier = options.tier;
    this.namespace = options.namespace;
    this.key = options.key;
  }
}

/** A write that failed: `set` stored the value in no tier, or `delete`/`clear` failed in a tier. */
export class CacheWriteError extends CacheError {
  override readonly name: string = 'CacheWriteError';
  override readonly code = 'WRITE_FAILED' as const;
  /** The per-tier failures, in tier order. Frozen. */
  readonly errors: readonly CacheError[];

  constructor(message: string, errors: readonly CacheError[], options?: CacheErrorOptions) {
    super('WRITE_FAILED', message, options);
    this.errors = Object.freeze([...errors]);
  }
}
