// The IndexedDB tier (ADR-0002 sections 6 to 8, 13, 14 and 17): the public `indexedDBTier` factory
// and its internal adapter.
import { CacheError, type CacheErrorCode } from './errors.js';
import { tierConfig } from './tier-config.js';
import {
  isQuotaError,
  readEnvelope,
  tierBudget,
  type CreateTierAdapter,
  type Envelope,
  type TierAdapter,
  type TierEmit,
} from './tier.js';
import type { IndexedDBTierOptions, TierFactory, TierStatus } from './types.js';

/**
 * The IndexedDB tier: entries live in database `pwa-cache-kit:<cache>`, shared by the origin's
 * tabs and workers. Unavailable where IndexedDB cannot be opened.
 * @throws {TypeError} for invalid budget options or `openTimeoutMs`.
 */
export const indexedDBTier: TierFactory<'indexeddb', IndexedDBTierOptions> = (options) =>
  tierConfig('indexeddb', indexedDBAdapter(options));

const STORE = 'entries';
const DEFAULT_OPEN_TIMEOUT_MS = 3000;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** A stored record: the envelope plus its primary key `[ns, key]` (section 14). */
type StoredRecord = Envelope & { readonly ns: string; readonly key: string };
type PrimaryKey = [ns: string, key: string];

/** The platform objects the adapter uses, read once in try/catch when it is created. */
interface Platform {
  readonly factory: IDBFactory;
  readonly KeyRange: typeof IDBKeyRange;
}

/**
 * Builds IndexedDB adapters with one budget and open timeout. Each adapter opens its cache's
 * database when it is created; operations wait for the open. The budget is soft: `set` only
 * refuses entries above `maxEntryBytes`, and `sweep` removes expired entries and evicts down to
 * `maxBytes` (sections 6 to 8).
 * @throws {TypeError} for invalid budget options or `openTimeoutMs`.
 */
export function indexedDBAdapter(options?: IndexedDBTierOptions): CreateTierAdapter<false> {
  const { maxBytes, maxEntryBytes } = tierBudget('indexeddb', options);
  const openTimeoutMs = options?.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  if (
    typeof openTimeoutMs !== 'number' ||
    !Number.isInteger(openTimeoutMs) ||
    openTimeoutMs < 1 ||
    openTimeoutMs > MAX_TIMER_MS
  ) {
    throw new TypeError('indexeddb tier: openTimeoutMs must be an integer from 1 to 2^31 - 1');
  }

  return (cacheName, emit) => {
    const platform = platformOf();
    const name = `pwa-cache-kit:${cacheName}`;
    let status: TierStatus = platform === undefined ? 'unavailable' : 'pending';
    let closed = false;
    let db: IDBDatabase | undefined;
    let opening: Promise<IDBDatabase | undefined> | undefined;

    /** Opens the database once, settling undefined (and the tier unavailable) on failure. */
    function open(factory: IDBFactory): Promise<IDBDatabase | undefined> {
      return new Promise((resolve) => {
        let settled = false;
        const fail = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          status = 'unavailable';
          resolve(undefined);
        };
        const timer = setTimeout(fail, openTimeoutMs);
        let request: IDBOpenDBRequest;
        try {
          request = factory.open(name, 1);
        } catch {
          fail();
          return;
        }
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore(STORE, { keyPath: ['ns', 'key'] });
          store.createIndex('expiresAt', 'expiresAt');
          store.createIndex('updatedAt', ['updatedAt', 'sizeBytes']);
        };
        request.onerror = (event) => {
          event.preventDefault();
          fail();
        };
        request.onsuccess = () => {
          const connection = request.result;
          if (settled || closed) {
            // Late or no longer wanted: never keep a connection that could block another context.
            connection.close();
            fail();
            return;
          }
          settled = true;
          clearTimeout(timer);
          const lose = () => {
            if (db === connection) db = undefined;
          };
          connection.onversionchange = () => {
            connection.close();
            lose();
          };
          connection.onclose = lose;
          db = connection;
          status = 'available';
          resolve(connection);
        };
      });
    }

    if (platform !== undefined) opening = open(platform.factory);

    function error(
      code: CacheErrorCode,
      message: string,
      ns?: string,
      key?: string,
      cause?: unknown,
    ): CacheError {
      const context = { tier: 'indexeddb', namespace: ns, key } as const;
      const options = cause === undefined ? context : { ...context, cause };
      return new CacheError(code, `indexeddb tier: ${message}`, options);
    }

    /**
     * The open connection. If it was lost, the first operation to find out starts one reopen
     * attempt, which operations arriving meanwhile share. Throws when the tier is unavailable.
     */
    async function connection(): Promise<[IDBDatabase, typeof IDBKeyRange]> {
      if (closed) throw new CacheError('CLOSED', 'indexeddb tier: closed', { tier: 'indexeddb' });
      const pending = opening;
      let current = await pending;
      if (current !== undefined && db === undefined && platform !== undefined) {
        if (opening === pending) opening = open(platform.factory);
        current = await opening;
      }
      if (current === undefined || platform === undefined || status === 'unavailable') {
        status = 'unavailable';
        throw new CacheError('TIER_UNAVAILABLE', 'indexeddb tier: database unavailable', {
          tier: 'indexeddb',
        });
      }
      return [current, platform.KeyRange];
    }

    /**
     * Runs `operation` on the connection. If the connection turns out lost, the operation makes
     * one reopen attempt and runs again on the new connection (section 13).
     */
    async function withDb<T>(
      ns: string | undefined,
      key: string | undefined,
      operation: (connection: IDBDatabase, KeyRange: typeof IDBKeyRange) => Promise<T>,
    ): Promise<T> {
      const [first, KeyRange] = await connection();
      try {
        return await operation(first, KeyRange);
      } catch (cause) {
        if (cause instanceof CacheError) throw cause;
        if (!isLost(cause))
          throw error('STORAGE_FAILED', 'storage operation failed', ns, key, cause);
        if (db === first) db = undefined;
        first.close();
      }
      const [second] = await connection();
      try {
        return await operation(second, KeyRange);
      } catch (cause) {
        if (cause instanceof CacheError) throw cause;
        throw error('STORAGE_FAILED', 'storage operation failed', ns, key, cause);
      }
    }

    async function put(connection: IDBDatabase, record: StoredRecord): Promise<void> {
      await transact(connection, 'readwrite', (store) => store.put(record));
    }

    const adapter: TierAdapter<false> = {
      name: 'indexeddb',
      sync: false,
      get status() {
        return status;
      },
      get(ns, key) {
        return withDb(ns, key, async (connection) => {
          const record = await transact(
            connection,
            'readonly',
            (store) => store.get([ns, key] satisfies PrimaryKey) as IDBRequest<unknown>,
          );
          if (record === undefined) return undefined;
          const envelope = readEnvelope(record);
          if (envelope === 'newer') return 'newer';
          if (envelope !== 'corrupt') return toEnvelope(envelope);
          await transact(connection, 'readwrite', (store) =>
            store.delete([ns, key] satisfies PrimaryKey),
          );
          throw error('CORRUPT_ENTRY', 'removed a record that is not a valid envelope', ns, key);
        });
      },
      async set(ns, key, envelope) {
        if (envelope.sizeBytes > maxEntryBytes) {
          const sizes = `${String(envelope.sizeBytes)} > ${String(maxEntryBytes)} bytes`;
          throw error('ENTRY_TOO_LARGE', `entry too large (${sizes})`, ns, key);
        }
        const record: StoredRecord = { ...envelope, ns, key };
        await withDb(ns, key, async (connection, KeyRange) => {
          try {
            await put(connection, record);
            return;
          } catch (cause) {
            if (isCloneError(cause)) {
              throw error('SERIALIZATION_FAILED', 'the value cannot be cloned', ns, key, cause);
            }
            if (!isQuotaError(cause)) throw cause;
          }
          // Out of quota: make room in eviction order, then retry once (section 7).
          await evict(connection, KeyRange, emit, 'quota', [ns, key], (_usage, freed) => {
            return freed >= envelope.sizeBytes;
          });
          try {
            await put(connection, record);
          } catch (cause) {
            const code = isQuotaError(cause) ? 'QUOTA_EXCEEDED' : 'STORAGE_FAILED';
            throw error(code, 'write failed after making room', ns, key, cause);
          }
        });
      },
      delete(ns, key) {
        return withDb(ns, key, async (connection) => {
          await transact(connection, 'readwrite', (store) =>
            store.delete([ns, key] satisfies PrimaryKey),
          );
        });
      },
      clear(ns) {
        return withDb(ns, undefined, async (connection, KeyRange) => {
          await transact(connection, 'readwrite', (store) =>
            ns === undefined ? store.clear() : store.delete(namespaceRange(KeyRange, ns)),
          );
        });
      },
      keys(ns) {
        return withDb(ns, undefined, async (connection, KeyRange) => {
          const keys = await transact(connection, 'readonly', (store) =>
            store.getAllKeys(namespaceRange(KeyRange, ns)),
          );
          return (keys ?? []).map((primaryKey) => (primaryKey as PrimaryKey)[1]);
        });
      },
      sweep() {
        return withDb(undefined, undefined, (connection, KeyRange) =>
          evict(connection, KeyRange, emit, 'budget', undefined, (usage) => usage <= maxBytes),
        );
      },
      close() {
        if (closed) return;
        closed = true;
        db?.close();
        db = undefined;
      },
    };
    return adapter;
  };
}

/** `indexedDB` and `IDBKeyRange`, read in try/catch; undefined where either is missing. */
function platformOf(): Platform | undefined {
  try {
    const { indexedDB: factory, IDBKeyRange: KeyRange } = globalThis as {
      indexedDB?: unknown;
      IDBKeyRange?: unknown;
    };
    if (typeof factory !== 'object' || factory === null || typeof KeyRange !== 'function') {
      return undefined;
    }
    return { factory: factory as IDBFactory, KeyRange: KeyRange as typeof IDBKeyRange };
  } catch {
    return undefined;
  }
}

/**
 * Runs one request in its own transaction and settles when the transaction completes, with the
 * request's result, or rejects with what aborted it: a request error, a quota error at commit, or
 * an exception thrown while making the request.
 */
function transact<T>(
  connection: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = connection.transaction(STORE, mode);
    let result: T | undefined;
    tx.oncomplete = () => {
      resolve(result);
    };
    tx.onabort = () => {
      reject(tx.error ?? new DOMException('The transaction was aborted', 'AbortError'));
    };
    let request: IDBRequest<T>;
    try {
      request = run(tx.objectStore(STORE));
    } catch (cause) {
      abort(tx);
      reject(asError(cause));
      return;
    }
    request.onsuccess = () => {
      result = request.result;
    };
  });
}

/**
 * Removes, in one transaction, the expired entries (`expire`), then the least recently written
 * live entries (`evict` with `reason`) until `done(usage, freed)` holds, sparing `spare`. Usage and
 * order come from the `updatedAt` index keys alone (section 14).
 */
function evict(
  connection: IDBDatabase,
  KeyRange: typeof IDBKeyRange,
  emit: TierEmit,
  reason: 'budget' | 'quota',
  spare: PrimaryKey | undefined,
  done: (usage: number, freed: number) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = connection.transaction(STORE, 'readwrite');
    tx.oncomplete = () => {
      resolve();
    };
    tx.onabort = () => {
      reject(tx.error ?? new DOMException('The transaction was aborted', 'AbortError'));
    };
    const store = tx.objectStore(STORE);
    const now = Date.now();
    const isSpare = (primaryKey: PrimaryKey) =>
      spare?.[0] === primaryKey[0] && spare[1] === primaryKey[1];
    let freed = 0;

    function removeExpired(): void {
      const expired = store.index('expiresAt').openCursor(KeyRange.upperBound(now));
      expired.onsuccess = () => {
        const cursor = expired.result;
        if (cursor === null) {
          evictLive();
          return;
        }
        const primaryKey = cursor.primaryKey as PrimaryKey;
        if (!isSpare(primaryKey)) {
          const record = cursor.value as StoredRecord;
          cursor.delete();
          freed += record.sizeBytes;
          if (emit.has('expire')) {
            emit({
              type: 'expire',
              namespace: primaryKey[0],
              key: primaryKey[1],
              tier: 'indexeddb',
            });
          }
        }
        cursor.continue();
      };
    }

    /** Reads the live entries in write order from index keys, then removes the oldest. */
    function evictLive(): void {
      const live: { primaryKey: PrimaryKey; sizeBytes: number }[] = [];
      let usage = 0;
      const keys = store.index('updatedAt').openKeyCursor();
      keys.onsuccess = () => {
        const cursor = keys.result;
        if (cursor !== null) {
          const sizeBytes = (cursor.key as [number, number])[1];
          live.push({ primaryKey: cursor.primaryKey as PrimaryKey, sizeBytes });
          usage += sizeBytes;
          cursor.continue();
          return;
        }
        for (const { primaryKey, sizeBytes } of live) {
          if (done(usage, freed)) return;
          if (isSpare(primaryKey)) continue;
          store.delete(primaryKey);
          usage -= sizeBytes;
          freed += sizeBytes;
          if (emit.has('evict')) {
            const [namespace, key] = primaryKey;
            emit({ type: 'evict', namespace, key, tier: 'indexeddb', sizeBytes, reason });
          }
        }
      };
    }

    removeExpired();
  });
}

function namespaceRange(KeyRange: typeof IDBKeyRange, ns: string): IDBKeyRange {
  return KeyRange.bound([ns], [ns, []]);
}

/** The envelope fields of a record, without its `ns` and `key`. */
function toEnvelope(record: Envelope): Envelope {
  const { format, value, schemaVersion, updatedAt, freshUntil, expiresAt, sizeBytes } = record;
  return {
    format,
    value,
    schemaVersion,
    updatedAt,
    sizeBytes,
    ...(freshUntil === undefined ? {} : { freshUntil }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function abort(tx: IDBTransaction): void {
  try {
    tx.abort();
  } catch {
    // Already finished.
  }
}

function isCloneError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'DataCloneError';
}

/** Whether an exception means the connection was closed under the operation (section 13). */
function isLost(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'InvalidStateError';
}
