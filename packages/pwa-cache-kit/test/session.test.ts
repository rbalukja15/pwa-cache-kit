import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheError, createCache, memoryTier, sessionTier } from '../src/index.js';
import { sessionAdapter } from '../src/session.js';
import type { Envelope, TierEmit, TierEvent } from '../src/tier.js';
import { runTierConformance } from './conformance/tier-conformance.js';

/** An in-memory `Storage` whose writes can be made to fail, standing in for `sessionStorage`. */
class FakeStorage implements Storage {
  readonly items = new Map<string, string>();
  failing: { count: number; kind: 'quota' | 'other' } = { count: 0, kind: 'quota' };
  [name: string]: unknown;

  get length(): number {
    return this.items.size;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failing.count > 0) {
      this.failing.count--;
      throw this.failing.kind === 'quota'
        ? new DOMException('Simulated quota error', 'QuotaExceededError')
        : new DOMException('Simulated storage error', 'UnknownError');
    }
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }
}

let storage = new FakeStorage();

function stubWindow(): void {
  vi.stubGlobal('window', { document: {}, sessionStorage: storage });
}

beforeEach(() => {
  storage = new FakeStorage();
  stubWindow();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

runTierConformance({
  name: 'session',
  tier: sessionAdapter,
  failWrites(count, kind = 'quota') {
    storage.failing = { count, kind };
  },
  writeRaw(cacheName, ns, key, kind) {
    const record =
      kind === 'newer'
        ? JSON.stringify({ format: 2, payload: 'written by a later version' })
        : '{"format": 1, "value": "truncated';
    storage.items.set(`pwa-cache-kit:${cacheName}:${ns}:${key}`, record);
  },
  reset() {
    storage.clear();
  },
});

describe('session adapter', () => {
  let events: TierEvent[] = [];
  const emit: TierEmit = Object.assign(
    (event: TierEvent) => {
      events.push(event);
    },
    { has: () => true },
  );

  beforeEach(() => {
    events = [];
  });

  function entry(value: Envelope['value'], sizeBytes = 10): Envelope {
    return { format: 1, value, schemaVersion: 1, updatedAt: Date.now(), sizeBytes };
  }

  it('stores the envelope JSON under pwa-cache-kit:<cache>:<ns>:<key>', () => {
    const adapter = sessionAdapter()('app', emit);
    const envelope = { ...entry({ seat: '12A' }), freshUntil: 5, expiresAt: 9 };

    adapter.set('tickets', 'a:b', envelope);

    expect([...storage.items]).toEqual([
      ['pwa-cache-kit:app:tickets:a:b', JSON.stringify(envelope)],
    ]);
    expect(adapter.keys('tickets')).toEqual(['a:b']);
  });

  it('clears only keys with its cache prefix', () => {
    storage.items.set('other', 'kept');
    storage.items.set('pwa-cache-kit:app2:ns:k', 'kept');
    storage.items.set('pwa-cache-kit:ap:ns:k', 'kept');
    const adapter = sessionAdapter()('app', emit);
    adapter.set('ns', 'k', entry('v'));
    adapter.set('ns2', 'k', entry('v'));

    adapter.clear('ns');
    expect(adapter.keys('ns2')).toEqual(['k']);
    adapter.clear();

    expect([...storage.items.keys()]).toEqual([
      'other',
      'pwa-cache-kit:app2:ns:k',
      'pwa-cache-kit:ap:ns:k',
    ]);
  });

  it('reads entries written before it was created, as after a reload', () => {
    sessionAdapter()('app', emit).set('ns', 'k', entry('v'));

    expect(sessionAdapter()('app', emit).get('ns', 'k')).toEqual(entry('v'));
  });

  it('counts entries already in storage towards its budget', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const options = { maxBytes: 100, maxEntryBytes: 50 };
      const earlier = sessionAdapter(options)('app', emit);
      earlier.set('ns', 'a', entry('v', 40));
      vi.advanceTimersByTime(1);
      earlier.set('ns', 'b', entry('v', 40));
      const later = sessionAdapter(options)('app', emit);
      vi.advanceTimersByTime(1);
      later.set('ns', 'c', entry('v', 40));

      expect(later.keys('ns').sort()).toEqual(['b', 'c']);
      expect(events).toEqual([
        {
          type: 'evict',
          namespace: 'ns',
          key: 'a',
          tier: 'session',
          sizeBytes: 40,
          reason: 'budget',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips records it cannot read when it counts usage', () => {
    storage.items.set('pwa-cache-kit:app:ns:broken', 'not json');
    storage.items.set('pwa-cache-kit:app:ns:newer', JSON.stringify({ format: 2 }));
    const adapter = sessionAdapter({ maxBytes: 100, maxEntryBytes: 100 })('app', emit);

    adapter.set('ns', 'k', entry('v', 100));

    expect(adapter.keys('ns').sort()).toEqual(['broken', 'k', 'newer']);
    expect(events).toEqual([]);
  });

  it.each([
    ['a bigint', 1n],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
  ])('refuses %s value with SERIALIZATION_FAILED and evicts nothing', (_, value) => {
    const adapter = sessionAdapter()('app', emit);
    adapter.set('ns', 'kept', entry('v'));

    expect(() => {
      adapter.set('ns', 'k', entry(value));
    }).toThrow(expect.objectContaining({ code: 'SERIALIZATION_FAILED', key: 'k' }) as unknown);
    expect(adapter.keys('ns')).toEqual(['kept']);
  });

  it('fails with QUOTA_EXCEEDED when even an empty cache cannot make room', () => {
    const adapter = sessionAdapter()('app', emit);
    storage.failing = { count: 2, kind: 'quota' };

    expect(() => {
      adapter.set('ns', 'k', entry('v'));
    }).toThrow(expect.objectContaining({ code: 'QUOTA_EXCEEDED' }) as unknown);
    expect(events).toEqual([]);
  });

  it('turns any storage exception into STORAGE_FAILED', () => {
    const adapter = sessionAdapter()('app', emit);
    adapter.set('ns', 'k', entry('v'));
    const broken = new Error('storage broke');
    for (const method of ['getItem', 'removeItem', 'key'] as const) {
      vi.spyOn(storage, method).mockImplementation(() => {
        throw broken;
      });
    }

    for (const call of [
      () => adapter.get('ns', 'k'),
      () => {
        adapter.delete('ns', 'k');
      },
      () => {
        adapter.clear();
      },
      () => adapter.keys('ns'),
    ]) {
      expect(call).toThrow(
        expect.objectContaining({
          code: 'STORAGE_FAILED',
          tier: 'session',
          cause: broken,
        }) as unknown,
      );
    }
  });

  it('fails with STORAGE_FAILED when the first scan of storage throws', () => {
    const adapter = sessionAdapter()('app', emit);
    storage.items.set('pwa-cache-kit:app:ns:k', JSON.stringify(entry('v')));
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('storage broke');
    });

    expect(() => {
      adapter.set('ns', 'other', entry('v'));
    }).toThrow(expect.objectContaining({ code: 'STORAGE_FAILED' }) as unknown);
  });

  it('fails with STORAGE_FAILED when making room throws', () => {
    const adapter = sessionAdapter()('app', emit);
    adapter.set('ns', 'a', entry('v'));
    storage.failing = { count: 1, kind: 'quota' };
    vi.spyOn(storage, 'removeItem').mockImplementation(() => {
      throw new Error('storage broke');
    });

    expect(() => {
      adapter.set('ns', 'b', entry('v'));
    }).toThrow(expect.objectContaining({ code: 'STORAGE_FAILED' }) as unknown);
  });

  it('keeps a write whose budget eviction fails, and reports the failure', () => {
    const adapter = sessionAdapter({ maxBytes: 100, maxEntryBytes: 60 })('app', emit);
    adapter.set('ns', 'a', entry('v', 60));
    const broken = new Error('storage broke');
    vi.spyOn(storage, 'removeItem').mockImplementation(() => {
      throw broken;
    });

    const written = entry('v', 60);
    expect(() => {
      adapter.set('ns', 'b', written);
    }).not.toThrow();

    expect(adapter.get('ns', 'b')).toEqual(written);
    expect(events).toEqual([
      {
        type: 'error',
        tier: 'session',
        namespace: 'ns',
        key: 'b',
        error: expect.objectContaining({ code: 'STORAGE_FAILED', cause: broken }) as unknown,
      },
    ]);
  });

  it('reports a failed budget eviction only to error listeners', () => {
    const silent: TierEmit = Object.assign(
      (event: TierEvent) => {
        events.push(event);
      },
      { has: () => false },
    );
    const adapter = sessionAdapter({ maxBytes: 100, maxEntryBytes: 60 })('app', silent);
    adapter.set('ns', 'a', entry('v', 60));
    vi.spyOn(storage, 'removeItem').mockImplementation(() => {
      throw new Error('storage broke');
    });

    adapter.set('ns', 'b', entry('v', 60));

    expect(events).toEqual([]);
  });

  it('fails with STORAGE_FAILED when the retry fails for another reason', () => {
    const adapter = sessionAdapter()('app', emit);
    storage.failing = { count: 1, kind: 'quota' };
    const setItem = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem')
      .mockImplementationOnce(setItem)
      .mockImplementationOnce(() => {
        throw new DOMException('Simulated storage error', 'UnknownError');
      });

    expect(() => {
      adapter.set('ns', 'k', entry('v'));
    }).toThrow(expect.objectContaining({ code: 'STORAGE_FAILED' }) as unknown);
  });

  it('can be used again after close', () => {
    const adapter = sessionAdapter()('app', emit);
    adapter.set('ns', 'k', entry('v'));
    adapter.close();
    adapter.set('ns', 'k2', entry('v'));
    expect(adapter.keys('ns').sort()).toEqual(['k', 'k2']);
  });
});

describe('without session storage', () => {
  function unavailable(): void {
    const adapter = sessionAdapter()(
      'app',
      Object.assign(() => undefined, { has: () => false }),
    );

    expect(adapter.status).toBe('unavailable');
    expect(adapter.get('ns', 'k')).toBeUndefined();
    expect(adapter.keys('ns')).toEqual([]);
    expect(() => {
      adapter.delete('ns', 'k');
      adapter.clear('ns');
      adapter.clear();
      adapter.close();
    }).not.toThrow();
    expect(() => {
      adapter.set('ns', 'k', {
        format: 1,
        value: 'v',
        schemaVersion: 1,
        updatedAt: 0,
        sizeBytes: 2,
      });
    }).toThrow(expect.objectContaining({ code: 'TIER_UNAVAILABLE' }) as unknown);
  }

  it('is unavailable in a worker, even with a global sessionStorage', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('importScripts', () => undefined);
    vi.stubGlobal('sessionStorage', storage);
    unavailable();
  });

  it('is unavailable when window.sessionStorage is null', () => {
    vi.stubGlobal('window', { document: {}, sessionStorage: null });
    unavailable();
  });

  it('is unavailable when reading window.sessionStorage throws', () => {
    vi.stubGlobal('window', {
      document: {},
      get sessionStorage() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
    unavailable();
  });

  it('is skipped by a cache, which keeps working with its other tiers', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('importScripts', () => undefined);
    const cache = createCache({ name: 'app', tiers: [memoryTier(), sessionTier()] });
    const errors: CacheError[] = [];
    cache.on('error', (event) => errors.push(event.error));

    expect(cache.status()).toEqual({ memory: 'available', session: 'unavailable' });
    await expect(
      cache.namespace('n', { tiers: ['memory', 'session'] }).set('k', 'v'),
    ).resolves.toEqual({ stored: ['memory'], errors: [] });
    await expect(cache.namespace('n', { tiers: ['session'] }).set('k', 'v')).resolves.toEqual({
      stored: [],
      errors: [],
    });
    expect(errors).toEqual([]);
  });
});

describe('sessionTier in a cache', () => {
  it('serves a value after a reload and promotes it into memory', async () => {
    const options = { tiers: ['memory', 'session'] } as const;
    const before = createCache({ name: 'app', tiers: [memoryTier(), sessionTier()] });
    await before.namespace('n', options).set('k', { seat: '12A' });
    before.close();

    const after = createCache({ name: 'app', tiers: [memoryTier(), sessionTier()] });
    const promoted: string[] = [];
    after.on('promote', (event) => promoted.push(`${event.from} -> ${event.tier}`));

    expect(after.namespace('n', options).getSync('k')).toEqual({ seat: '12A' });
    expect(promoted).toEqual(['session -> memory']);
    expect(after.namespace('n', { tiers: ['memory'] }).getSync('k')).toEqual({ seat: '12A' });
  });

  it('rejects invalid budget options when the factory is called', () => {
    expect(() => sessionTier({ maxBytes: 0 })).toThrow(TypeError);
  });
});
