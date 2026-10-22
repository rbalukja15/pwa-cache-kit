// The SessionStorage tier (ADR-0002 sections 6, 7, 10, 13, 14 and 17): the public `sessionTier`
// factory and its internal adapter.
import { CacheError, type CacheErrorCode } from './errors.js';
import { tierConfig } from './tier-config.js';
import {
  isQuotaError,
  readEnvelope,
  tierBudget,
  type CreateTierAdapter,
  type Envelope,
  type TierAdapter,
} from './tier.js';
import type { TierFactory, TierOptions } from './types.js';

/**
 * The session tier: entries live in `window.sessionStorage`, survive reloads of the tab and are
 * not shared with other tabs. Unavailable in workers and wherever that storage cannot be read.
 * @throws {TypeError} for invalid budget options.
 */
export const sessionTier: TierFactory<'session'> = (options) =>
  tierConfig('session', sessionAdapter(options));

const PREFIX = 'pwa-cache-kit:';

/** What eviction needs to know about a stored entry, so it does not parse it again. */
interface Stored {
  readonly ns: string;
  readonly key: string;
  readonly sizeBytes: number;
  readonly updatedAt: number;
  readonly expiresAt: number | undefined;
}

/**
 * Builds session adapters with one budget. Each entry is stored under
 * `pwa-cache-kit:<cache>:<ns>:<key>` with the envelope's JSON as value (section 14). The adapter
 * keeps an index of its cache's entries to track usage; it builds the index on the first write and
 * rebuilds it from storage before each eviction, so entries another instance of the same cache
 * wrote in this tab are counted there.
 * @throws {TypeError} for invalid budget options (see `tierBudget`).
 */
export function sessionAdapter(options?: TierOptions): CreateTierAdapter<true> {
  const { maxBytes, maxEntryBytes } = tierBudget('session', options);

  return (cacheName, emit) => {
    const storage = sessionStorageOf();
    const cachePrefix = `${PREFIX}${cacheName}:`;
    let index: Map<string, Stored> | undefined;
    let usage = 0;

    function storageKey(ns: string, key: string): string {
      return `${cachePrefix}${ns}:${key}`;
    }

    function error(
      code: CacheErrorCode,
      message: string,
      ns?: string,
      key?: string,
      cause?: unknown,
    ) {
      const context = { tier: 'session', namespace: ns, key } as const;
      const options = cause === undefined ? context : { ...context, cause };
      return new CacheError(code, `session tier: ${message}`, options);
    }

    /** Runs a storage call, turning an exception into `STORAGE_FAILED`. */
    function attempt<T>(call: () => T, ns?: string, key?: string): T {
      try {
        return call();
      } catch (cause) {
        throw error('STORAGE_FAILED', 'storage operation failed', ns, key, cause);
      }
    }

    /** The storage keys of this cache, or of one namespace, collected before any removal. */
    function ownKeys(store: Storage, prefix: string): string[] {
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const id = store.key(i);
        if (id?.startsWith(prefix)) keys.push(id);
      }
      return keys;
    }

    /** Reads every valid envelope of this cache from storage into a new index. */
    function scan(store: Storage): Map<string, Stored> {
      const scanned = new Map<string, Stored>();
      usage = 0;
      for (const id of ownKeys(store, cachePrefix)) {
        const envelope = parse(store.getItem(id));
        if (typeof envelope !== 'object') continue;
        const rest = id.slice(cachePrefix.length);
        const separator = rest.indexOf(':');
        scanned.set(id, describe(rest.slice(0, separator), rest.slice(separator + 1), envelope));
        usage += envelope.sizeBytes;
      }
      return scanned;
    }

    function forget(id: string): void {
      const stored = index?.get(id);
      if (stored === undefined) return;
      index?.delete(id);
      usage -= stored.sizeBytes;
    }

    /**
     * Removes entries, expired ones first, then the least recently written, sparing `spare`, until
     * `done` holds. Rebuilds the index first so the order covers every entry of the cache.
     */
    function evict(
      store: Storage,
      spare: string,
      reason: 'budget' | 'quota',
      done: (freed: number) => boolean,
    ): void {
      index = scan(store);
      const now = Date.now();
      const isExpired = (stored: Stored) =>
        stored.expiresAt !== undefined && stored.expiresAt <= now;
      const candidates = [...index]
        .filter(([id]) => id !== spare)
        .sort(
          ([, a], [, b]) =>
            Number(isExpired(b)) - Number(isExpired(a)) || a.updatedAt - b.updatedAt,
        );
      let freed = 0;
      for (const [id, stored] of candidates) {
        if (done(freed)) return;
        store.removeItem(id);
        forget(id);
        freed += stored.sizeBytes;
        const { ns: namespace, key, sizeBytes } = stored;
        if (isExpired(stored)) {
          if (emit.has('expire')) emit({ type: 'expire', namespace, key, tier: 'session' });
        } else if (emit.has('evict')) {
          emit({ type: 'evict', namespace, key, tier: 'session', sizeBytes, reason });
        }
      }
    }

    function write(store: Storage, ns: string, key: string, envelope: Envelope): void {
      if (envelope.sizeBytes > maxEntryBytes) {
        const sizes = `${String(envelope.sizeBytes)} > ${String(maxEntryBytes)} bytes`;
        throw error('ENTRY_TOO_LARGE', `entry too large (${sizes})`, ns, key);
      }
      const json = serialize(envelope);
      if (json === undefined) {
        throw error('SERIALIZATION_FAILED', 'the value is not JSON-safe', ns, key);
      }
      const id = storageKey(ns, key);
      index ??= attempt(() => scan(store), ns, key);
      try {
        store.setItem(id, json);
      } catch (cause) {
        if (!isQuotaError(cause)) {
          throw error('STORAGE_FAILED', 'write failed', ns, key, cause);
        }
        attempt(
          () => {
            evict(store, id, 'quota', (freed) => freed >= envelope.sizeBytes);
          },
          ns,
          key,
        );
        try {
          store.setItem(id, json);
        } catch (retryCause) {
          const code = isQuotaError(retryCause) ? 'QUOTA_EXCEEDED' : 'STORAGE_FAILED';
          throw error(code, 'write failed after making room', ns, key, retryCause);
        }
      }
      forget(id);
      index.set(id, describe(ns, key, envelope));
      usage += envelope.sizeBytes;
      if (usage > maxBytes) {
        attempt(
          () => {
            evict(store, id, 'budget', () => usage <= maxBytes);
          },
          ns,
          key,
        );
      }
    }

    if (storage === undefined) return unavailableAdapter();

    const adapter: TierAdapter<true> = {
      name: 'session',
      sync: true,
      status: 'available',
      get(ns, key) {
        const id = storageKey(ns, key);
        const json = attempt(() => storage.getItem(id), ns, key);
        if (json === null) return undefined;
        const envelope = parse(json);
        if (envelope !== 'corrupt') return envelope;
        attempt(
          () => {
            storage.removeItem(id);
          },
          ns,
          key,
        );
        forget(id);
        throw error('CORRUPT_ENTRY', 'removed a record that is not a valid envelope', ns, key);
      },
      set(ns, key, envelope) {
        write(storage, ns, key, envelope);
      },
      delete(ns, key) {
        const id = storageKey(ns, key);
        attempt(
          () => {
            storage.removeItem(id);
          },
          ns,
          key,
        );
        forget(id);
      },
      clear(ns) {
        const prefix = ns === undefined ? cachePrefix : storageKey(ns, '');
        attempt(() => {
          for (const id of ownKeys(storage, prefix)) {
            storage.removeItem(id);
            forget(id);
          }
        }, ns);
      },
      keys(ns) {
        const prefix = storageKey(ns, '');
        return attempt(() => ownKeys(storage, prefix), ns).map((id) => id.slice(prefix.length));
      },
      close() {
        index = undefined;
        usage = 0;
      },
    };
    return adapter;
  };
}

/** `window.sessionStorage`, read in try/catch and never as a global (section 13). */
function sessionStorageOf(): Storage | undefined {
  try {
    const { window: win } = globalThis as { window?: unknown };
    if (typeof win !== 'object' || win === null) return undefined;
    const { sessionStorage: storage } = win as { sessionStorage?: unknown };
    return typeof storage === 'object' && storage !== null ? (storage as Storage) : undefined;
  } catch {
    return undefined;
  }
}

/** The adapter of a context without session storage: reads miss and writes are refused. */
function unavailableAdapter(): TierAdapter<true> {
  return {
    name: 'session',
    sync: true,
    status: 'unavailable',
    get: () => undefined,
    set(ns, key) {
      const context = { tier: 'session', namespace: ns, key } as const;
      throw new CacheError('TIER_UNAVAILABLE', 'session tier: storage is unavailable', context);
    },
    delete: () => undefined,
    clear: () => undefined,
    keys: () => [],
    close: () => undefined,
  };
}

/** The envelope's JSON, or undefined when the value cannot round-trip through it. */
function serialize(envelope: Envelope): string | undefined {
  // A top-level function or symbol would vanish from the JSON; nested ones are not checked
  // (section 5: no deep validation).
  if (typeof envelope.value === 'function' || typeof envelope.value === 'symbol') return undefined;
  try {
    return JSON.stringify(envelope);
  } catch {
    return undefined;
  }
}

/** A stored record read back: an envelope, `'newer'`, `'corrupt'`, or undefined when absent. */
function parse(json: string | null): Envelope | 'newer' | 'corrupt' | undefined {
  if (json === null) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(json);
  } catch {
    return 'corrupt';
  }
  return readEnvelope(record);
}

function describe(ns: string, key: string, envelope: Envelope): Stored {
  const { sizeBytes, updatedAt, expiresAt } = envelope;
  return { ns, key, sizeBytes, updatedAt, expiresAt };
}
