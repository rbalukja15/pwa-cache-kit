import {
  IDBDatabase as FakeIDBDatabase,
  IDBFactory as FakeIDBFactory,
  IDBKeyRange as FakeIDBKeyRange,
  IDBObjectStore as FakeIDBObjectStore,
} from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheError, createCache, indexedDBTier, memoryTier } from '../src/index.js';
import { indexedDBAdapter } from '../src/indexeddb.js';
import type { Envelope, TierAdapter, TierEmit, TierEvent } from '../src/tier.js';
import { runTierConformance } from './conformance/tier-conformance.js';

let factory = new FakeIDBFactory();

/** How the next writes fail, set by the harness and the tests below. */
let failing: { count: number; fail: (store: IDBObjectStore) => void } = {
  count: 0,
  fail: () => undefined,
};

// Every put goes through `failing` first, so the harness can make writes fail in storage.
const put: unknown = Object.getOwnPropertyDescriptor(FakeIDBObjectStore.prototype, 'put')?.value;
if (typeof put !== 'function') throw new Error('fake-indexeddb has no IDBObjectStore.put');
Object.defineProperty(FakeIDBObjectStore.prototype, 'put', {
  configurable: true,
  writable: true,
  value(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>): IDBRequest {
    if (failing.count > 0) {
      failing.count--;
      failing.fail(this);
    }
    const request: unknown = Reflect.apply(put, this, args);
    return request as IDBRequest;
  },
});

function throwing(error: () => unknown): (store: IDBObjectStore) => void {
  return () => {
    throw error();
  };
}

const quotaError = () => new DOMException('Simulated quota error', 'QuotaExceededError');

function useFreshDatabases(): void {
  factory = new FakeIDBFactory();
  vi.stubGlobal('indexedDB', factory);
  vi.stubGlobal('IDBKeyRange', FakeIDBKeyRange);
}

beforeEach(() => {
  useFreshDatabases();
  failing = { count: 0, fail: () => undefined };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Opens the cache's database next to the adapter, as another context would. */
function openDatabase(cacheName: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(`pwa-cache-kit:${cacheName}`, version);
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('open failed'));
    };
  });
}

runTierConformance({
  name: 'indexeddb',
  tier: indexedDBAdapter,
  failWrites(count, kind = 'quota') {
    const error =
      kind === 'quota' ? quotaError : () => new DOMException('Simulated error', 'UnknownError');
    failing = { count, fail: throwing(error) };
  },
  async writeRaw(cacheName, ns, key, kind) {
    const db = await openDatabase(cacheName);
    const record =
      kind === 'newer'
        ? { ns, key, format: 2, payload: 'written by a later version' }
        : { ns, key, format: 1, value: 'no schemaVersion, updatedAt or sizeBytes' };
    await new Promise<void>((resolve) => {
      const tx = db.transaction('entries', 'readwrite');
      tx.objectStore('entries').put(record);
      tx.oncomplete = () => {
        resolve();
      };
    });
    db.close();
  },
  reset() {
    useFreshDatabases();
  },
});

describe('indexeddb adapter', () => {
  let events: TierEvent[] = [];
  let adapters: TierAdapter<false>[] = [];
  const emit: TierEmit = Object.assign(
    (event: TierEvent) => {
      events.push(event);
    },
    { has: () => true },
  );

  beforeEach(() => {
    events = [];
  });

  afterEach(() => {
    for (const adapter of adapters) adapter.close();
    adapters = [];
  });

  function create(options?: Parameters<typeof indexedDBAdapter>[0], cacheName = 'app') {
    const adapter = indexedDBAdapter(options)(cacheName, emit);
    adapters.push(adapter);
    return adapter;
  }

  function entry(value: Envelope['value'], overrides: Partial<Envelope> = {}): Envelope {
    return {
      format: 1,
      value,
      schemaVersion: 1,
      updatedAt: Date.now(),
      sizeBytes: 10,
      ...overrides,
    };
  }

  it('stores the envelope with ns and key in database pwa-cache-kit:<cache>', async () => {
    const adapter = create();
    await adapter.set('tickets', 't1', entry({ seat: '12A' }, { expiresAt: 5 }));

    const db = await openDatabase('app');
    const store = db.transaction('entries').objectStore('entries');
    expect(db.version).toBe(1);
    expect(store.keyPath).toEqual(['ns', 'key']);
    expect(store.index('expiresAt').keyPath).toBe('expiresAt');
    expect(store.index('updatedAt').keyPath).toEqual(['updatedAt', 'sizeBytes']);
    const record = await new Promise((resolve) => {
      const request = store.get(['tickets', 't1']);
      request.onsuccess = () => {
        resolve(request.result);
      };
    });
    expect(record).toMatchObject({ ns: 'tickets', key: 't1', value: { seat: '12A' } });
    db.close();
  });

  it('keeps structured-clone values that JSON would lose', async () => {
    const adapter = create();
    const value = { when: new Date(0), tags: new Map([['a', 1]]), bytes: new Uint8Array([1, 2]) };

    await adapter.set('ns', 'k', entry(value));

    expect(await adapter.get('ns', 'k')).toMatchObject({ value });
  });

  it('refuses a value that cannot be cloned with SERIALIZATION_FAILED', async () => {
    const adapter = create();
    const error: unknown = await adapter
      .set(
        'ns',
        'k',
        entry(() => 1),
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'SERIALIZATION_FAILED', tier: 'indexeddb', key: 'k' });
  });

  it('fails with QUOTA_EXCEEDED when a transaction aborts with a quota error at commit', async () => {
    const adapter = create();
    await adapter.set('ns', 'a', entry('v'));
    failing = {
      count: 2,
      fail(store) {
        const tx = store.transaction;
        Object.defineProperty(tx, 'error', { value: quotaError() });
        queueMicrotask(() => {
          tx.abort();
        });
      },
    };

    const error: unknown = await adapter.set('ns', 'b', entry('v')).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'QUOTA_EXCEEDED', key: 'b' });
    expect(events).toEqual([
      {
        type: 'evict',
        namespace: 'ns',
        key: 'a',
        tier: 'indexeddb',
        sizeBytes: 10,
        reason: 'quota',
      },
    ]);
  });

  it('fails with STORAGE_FAILED when the retry fails for another reason', async () => {
    const adapter = create();
    let calls = 0;
    failing = {
      count: 2,
      fail: () => {
        calls++;
        throw calls === 1 ? quotaError() : new Error('storage broke');
      },
    };

    const error: unknown = await adapter.set('ns', 'k', entry('v')).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('evicts the oldest entries in sweep down to maxBytes, after removing expired ones', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    const adapter = create({ maxBytes: 100, maxEntryBytes: 50 });
    for (const [key, sizeBytes] of [
      ['a', 40],
      ['b', 40],
      ['c', 40],
    ] as const) {
      vi.advanceTimersByTime(1);
      await adapter.set('ns', key, entry('v', { sizeBytes }));
    }
    await adapter.set('ns', 'old', entry('v', { sizeBytes: 5, expiresAt: 1_000 }));

    await adapter.sweep?.();

    expect((await adapter.keys('ns')).sort()).toEqual(['b', 'c']);
    expect(events).toEqual([
      { type: 'expire', namespace: 'ns', key: 'old', tier: 'indexeddb' },
      {
        type: 'evict',
        namespace: 'ns',
        key: 'a',
        tier: 'indexeddb',
        sizeBytes: 40,
        reason: 'budget',
      },
    ]);
  });

  it('is pending until the database opens, then available', async () => {
    const adapter = create();
    expect(adapter.status).toBe('pending');
    await adapter.keys('ns');
    expect(adapter.status).toBe('available');
  });

  it('rejects calls after close with CLOSED', async () => {
    const adapter = create();
    adapter.close();
    await expect(adapter.get('ns', 'k')).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('closes a connection that opens after close', async () => {
    const close = vi.spyOn(FakeIDBDatabase.prototype, 'close');
    const adapter = create();
    adapter.close();
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalled();
    });
    expect(adapter.status).toBe('unavailable');
  });

  it.each([0, 1.5, 2 ** 31, '1'])('rejects openTimeoutMs %s with a TypeError', (openTimeoutMs) => {
    expect(() => indexedDBTier({ openTimeoutMs } as never)).toThrow(TypeError);
  });

  describe('without a usable database', () => {
    async function expectUnavailable(adapter: TierAdapter<false>) {
      await expect(adapter.get('ns', 'k')).rejects.toMatchObject({ code: 'TIER_UNAVAILABLE' });
      expect(adapter.status).toBe('unavailable');
      await expect(adapter.set('ns', 'k', entry('v'))).rejects.toMatchObject({
        code: 'TIER_UNAVAILABLE',
      });
    }

    it('is unavailable from the start without indexedDB', async () => {
      vi.stubGlobal('indexedDB', undefined);
      const adapter = create();
      expect(adapter.status).toBe('unavailable');
      await expectUnavailable(adapter);
    });

    it('is unavailable when reading indexedDB throws', async () => {
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        get() {
          throw new DOMException('Blocked', 'SecurityError');
        },
      });
      try {
        await expectUnavailable(create());
      } finally {
        Reflect.deleteProperty(globalThis, 'indexedDB');
      }
    });

    it('becomes unavailable when open throws', async () => {
      vi.spyOn(factory, 'open').mockImplementation(() => {
        throw new DOMException('Blocked', 'SecurityError');
      });
      await expectUnavailable(create());
    });

    it('becomes unavailable when the open fails', async () => {
      const older = await openDatabase('app', 2);
      older.close();
      await expectUnavailable(create());
    });

    it('becomes unavailable when the open does not succeed in time, and closes a late one', async () => {
      // An open that never settles on its own, as with some WebKit opens.
      const close = vi.fn();
      const request = { result: { close } } as unknown as IDBOpenDBRequest;
      vi.spyOn(factory, 'open').mockReturnValue(request);
      const adapter = create({ openTimeoutMs: 5 });

      await expectUnavailable(adapter);
      request.onsuccess?.call(request, new Event('success'));

      expect(close).toHaveBeenCalled();
      expect(adapter.status).toBe('unavailable');
    });
  });

  describe('a lost connection', () => {
    it('closes on versionchange, so a deletion goes through, and reopens once', async () => {
      const adapter = create();
      await adapter.set('ns', 'k', entry('v'));

      await new Promise<void>((resolve, reject) => {
        const request = factory.deleteDatabase('pwa-cache-kit:app');
        request.onsuccess = () => {
          resolve();
        };
        request.onblocked = () => {
          reject(new Error('blocked by the adapter'));
        };
      });

      expect(await adapter.get('ns', 'k')).toBeUndefined();
      await adapter.set('ns', 'k', entry('again'));
      expect(await adapter.get('ns', 'k')).toMatchObject({ value: 'again' });
      expect(adapter.status).toBe('available');
    });

    it('turns unavailable for good when the reopen fails', async () => {
      const adapter = create();
      await adapter.keys('ns');

      const newer = await openDatabase('app', 2);
      newer.close();

      await expect(adapter.keys('ns')).rejects.toMatchObject({ code: 'TIER_UNAVAILABLE' });
      expect(adapter.status).toBe('unavailable');
    });

    it('reopens and runs again when a transaction finds the connection closed', async () => {
      const adapter = create();
      await adapter.set('ns', 'k', entry('v'));
      vi.spyOn(FakeIDBDatabase.prototype, 'transaction').mockImplementationOnce(() => {
        throw new DOMException('The connection is closing', 'InvalidStateError');
      });

      expect(await adapter.get('ns', 'k')).toMatchObject({ value: 'v' });
    });

    it('fails with STORAGE_FAILED when the run on the new connection fails too', async () => {
      const adapter = create();
      await adapter.keys('ns');
      const lost = () => {
        throw new DOMException('The connection is closing', 'InvalidStateError');
      };
      vi.spyOn(FakeIDBDatabase.prototype, 'transaction')
        .mockImplementationOnce(lost)
        .mockImplementationOnce(lost);

      await expect(adapter.keys('ns')).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    });
  });
});

describe('indexedDBTier in a cache', () => {
  beforeEach(() => {
    vi.stubGlobal('importScripts', () => undefined);
  });

  it('serves a value to a new cache instance and promotes it into memory', async () => {
    const tiers = () => [memoryTier(), indexedDBTier()];
    const options = { tiers: ['memory', 'indexeddb'] } as const;
    const first = createCache({ name: 'app', tiers: tiers(), sweepIntervalMs: 0 });
    await expect(first.namespace('n', options).set('k', new Map([['a', 1]]))).resolves.toEqual({
      stored: ['memory', 'indexeddb'],
      errors: [],
    });
    first.close();

    const second = createCache({ name: 'app', tiers: tiers(), sweepIntervalMs: 0 });
    const promoted: string[] = [];
    second.on('promote', (event) => promoted.push(`${event.from} -> ${event.tier}`));

    await expect(second.namespace('n', options).get('k')).resolves.toEqual(new Map([['a', 1]]));
    expect(promoted).toEqual(['indexeddb -> memory']);
    second.close();
  });

  it('only shows a tier unavailable from the start in status, emitting nothing', async () => {
    vi.spyOn(factory, 'open').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });
    const cache = createCache({ name: 'app', tiers: [indexedDBTier()], sweepIntervalMs: 0 });
    const errors: CacheError[] = [];
    cache.on('error', (event) => errors.push(event.error));
    const ns = cache.namespace('n', { tiers: ['indexeddb'] });

    await expect(ns.get('k')).resolves.toBeUndefined();
    await expect(ns.set('k', 'v')).resolves.toEqual({ stored: [], errors: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cache.status()).toEqual({ indexeddb: 'unavailable' });
    expect(errors).toEqual([]);
    cache.close();
  });

  it('reports a tier that turns unavailable once, not per failed operation', async () => {
    // A database of a later version makes the open fail after createCache returns.
    const newer = await openDatabase('app', 2);
    newer.close();
    const cache = createCache({
      name: 'app',
      tiers: [memoryTier(), indexedDBTier()],
      sweepIntervalMs: 0,
    });
    const errors: CacheError[] = [];
    cache.on('error', (event) => errors.push(event.error));
    const ns = cache.namespace('n', { tiers: ['memory', 'indexeddb'] });

    await ns.get('k');
    await ns.set('k', 'v');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors.map((error) => error.code)).toEqual(['TIER_UNAVAILABLE']);
    expect(errors[0]?.tier).toBe('indexeddb');
    expect(cache.status()).toEqual({ memory: 'available', indexeddb: 'unavailable' });
    cache.close();
  });
});
