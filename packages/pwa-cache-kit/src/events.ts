import type { CacheError } from './errors.js';
import type { TierName } from './types.js';

/** Fields of an event about one key in one tier. */
interface KeyEvent<T extends string> {
  readonly type: T;
  readonly namespace: string;
  readonly key: string;
  readonly tier: TierName;
}

/** Expiry of a stored copy in ms since the epoch; absent means never. */
interface Expiry {
  readonly freshUntil?: number;
  readonly expiresAt?: number;
}

/** A cache event (ADR-0002 section 11); `type` narrows it to its payload. */
export type CacheEvent =
  | (KeyEvent<'hit'> & Expiry & { readonly sizeBytes: number })
  | (KeyEvent<'miss'> & {
      readonly reason: 'absent' | 'stale' | 'expired' | 'newer' | 'invalid' | 'error';
    })
  | (KeyEvent<'set'> &
      Expiry & { readonly sizeBytes: number; readonly reason: 'set' | 'load' | 'migrate' })
  | (KeyEvent<'promote'> & Expiry & { readonly sizeBytes: number; readonly from: TierName })
  | (KeyEvent<'delete'> & { readonly reason: 'delete' | 'remote' })
  | KeyEvent<'expire'>
  | (KeyEvent<'evict'> & { readonly sizeBytes: number; readonly reason: 'budget' | 'quota' })
  | {
      readonly type: 'clear';
      /** Absent when every namespace of the cache was cleared. */
      readonly namespace?: string;
      readonly tier: TierName;
      readonly reason: 'clear' | 'remote';
    }
  | {
      readonly type: 'error';
      readonly error: CacheError;
      readonly namespace?: string;
      readonly key?: string;
      readonly tier?: TierName;
    };

/** Name of a cache event. */
export type CacheEventType = CacheEvent['type'];

/** Handler for one event type; it receives that type's payload. */
export type CacheEventHandler<T extends CacheEventType> = (
  event: Extract<CacheEvent, { type: T }>,
) => void;
