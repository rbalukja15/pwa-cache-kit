import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  CacheError,
  CacheWriteError,
  createCache,
  memoryTier,
  type CacheEvent,
  type CacheEventType,
  type CacheNamespace,
  type TieredCache,
  type TierConfig,
  type TierName,
} from '../src/index.js';
import { estimateSize } from '../src/size.js';
import { tierConfig } from '../src/tier-config.js';
import type { CreateTierAdapter, TierAdapter } from '../src/tier.js';
import type { TierStatus } from '../src/types.js';
import { createReferenceTier } from './conformance/reference-tier.js';

// Reference tiers stand in for session (sync) and IndexedDB (async) until #10 and #11.
const session = createReferenceTier('session', true);
const indexeddb = createReferenceTier('indexeddb', false);
const sessionTier = (): TierConfig<'session'> => tierConfig('session', session.tier());
const indexedDBTier = (): TierConfig<'indexeddb'> => tierConfig('indexeddb', indexeddb.tier());

const ALL_EVENTS: readonly CacheEventType[] = [
  'hit',
  'miss',
  'set',
  'promote',
  'delete',
  'expire',
  'evict',
  'clear',
  'error',
];

/** Records every event of `cache` in dispatch order. */
function record(cache: TieredCache, types: readonly CacheEventType[] = ALL_EVENTS): CacheEvent[] {
  const events: CacheEvent[] = [];
  for (const type of types) {
    cache.on(type, (event) => {
      events.push(event);
    });
  }
  return events;
}

function threeTiers(options: { sweepIntervalMs?: number } = {}): TieredCache {
  return createCache({
    name: 'app',
    tiers: [indexedDBTier(), memoryTier(), sessionTier()],
    sweepIntervalMs: 0,
    ...options,
  });
}

/** Lets queued microtasks and promise chains settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** A sync tier built from `overrides`; every operation not overridden throws. */
function scriptedTier(
  name: TierName,
  overrides: Partial<TierAdapter<true>> = {},
): { config: TierConfig; adapter: TierAdapter<true> } {
  const fail = (): never => {
    throw new Error(`${name} broke`);
  };
  const adapter: TierAdapter<true> = {
    name,
    sync: true,
    status: 'available',
    get: fail,
    set: fail,
    delete: fail,
    clear: fail,
    keys: fail,
    close: () => undefined,
  };
  // Descriptors, not a spread, so a `status` getter stays live.
  Object.defineProperties(adapter, Object.getOwnPropertyDescriptors(overrides));
  return { config: tierConfig(name, () => adapter), adapter };
}

beforeEach(async () => {
  // A worker scope is enough for the cache to count as running in a browser context.
  vi.stubGlobal('importScripts', () => undefined);
  await session.reset?.();
  await indexeddb.reset?.();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createCache options', () => {
  it.each([
    ['options that are not an object', null],
    ['an invalid name', { name: 'a b', tiers: [memoryTier()] }],
    ['a name longer than 64 characters', { name: 'a'.repeat(65), tiers: [memoryTier()] }],
    ['no tiers', { name: 'app', tiers: [] }],
    ['tiers that are not an array', { name: 'app', tiers: memoryTier() }],
    ['a forged tier', { name: 'app', tiers: [{ name: 'memory' }] }],
    ['a duplicate tier', { name: 'app', tiers: [memoryTier(), memoryTier()] }],
    ['a negative sweep interval', { name: 'app', tiers: [memoryTier()], sweepIntervalMs: -1 }],
    ['a fractional sweep interval', { name: 'app', tiers: [memoryTier()], sweepIntervalMs: 1.5 }],
    [
      'a sweep interval above 2^31 - 1',
      { name: 'app', tiers: [memoryTier()], sweepIntervalMs: 2 ** 31 },
    ],
    ['a broadcast that is not a boolean', { name: 'app', tiers: [memoryTier()], broadcast: 1 }],
  ])('rejects %s', (_, options) => {
    expect(() => createCache(options as never)).toThrow(TypeError);
  });

  it('accepts a zero sweep interval and a boolean broadcast', () => {
    const cache = createCache({
      name: 'app.v1_x-y',
      tiers: [memoryTier()],
      sweepIntervalMs: 0,
      broadcast: false,
    });
    expect(cache.name).toBe('app.v1_x-y');
    expect(cache.status()).toEqual({ memory: 'available' });
  });
});

describe('namespace options', () => {
  const cache = (): TieredCache =>
    createCache({ name: 'app', tiers: [memoryTier(), sessionTier()] });

  it.each([
    ['an invalid name', 'a/b', { tiers: ['memory'] }],
    ['options that are not an object', 'n', undefined],
    ['no tiers', 'n', { tiers: [] }],
    ['a tier the cache does not have', 'n', { tiers: ['indexeddb'] }],
    ['a duplicate tier', 'n', { tiers: ['memory', 'memory'] }],
    ['a zero ttl', 'n', { tiers: ['memory'], ttlMs: 0 }],
    ['a ttl that is not a number', 'n', { tiers: ['memory'], ttlMs: '1' }],
    ['a negative stale window', 'n', { tiers: ['memory'], staleWhileRevalidateMs: -1 }],
    ['a version below 1', 'n', { tiers: ['memory'], version: 0 }],
    ['a fractional version', 'n', { tiers: ['memory'], version: 1.5 }],
    ['migrations that are not an object', 'n', { tiers: ['memory'], migrations: 1 }],
  ])('rejects %s', (_, name, options) => {
    expect(() => cache().namespace(name, options as never)).toThrow(TypeError);
  });

  it('accepts a policy in any order and an Infinity ttl', () => {
    const ns = cache().namespace('n', { tiers: ['session', 'memory'], ttlMs: Infinity });
    expect(ns.name).toBe('n');
  });
});

describe('outside a browser context', () => {
  it('creates no adapters, starts no timer and stores nothing', async () => {
    vi.unstubAllGlobals();
    vi.useFakeTimers();
    const create = vi.fn<CreateTierAdapter>();
    const cache = createCache({ name: 'app', tiers: [tierConfig('memory', create)] });
    const ns = cache.namespace('n', { tiers: ['memory'] });

    expect(cache.status()).toEqual({ memory: 'unavailable' });
    await expect(ns.set('k', 'v')).resolves.toEqual({ stored: [], errors: [] });
    await expect(ns.get('k')).resolves.toBeUndefined();
    expect(ns.getSync('k')).toBeUndefined();
    await expect(ns.has('k')).resolves.toBe(false);
    await expect(ns.keys()).resolves.toEqual([]);
    await expect(ns.delete('k')).resolves.toBeUndefined();
    await expect(ns.clear()).resolves.toBeUndefined();
    await expect(cache.clear()).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still validates arguments', async () => {
    vi.unstubAllGlobals();
    const ns = createCache({ name: 'app', tiers: [memoryTier()] }).namespace('n', {
      tiers: ['memory'],
    });
    await expect(ns.set('k', undefined as never)).rejects.toThrow(TypeError);
  });

  it('counts a window with a document as a browser context', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('window', { document: {} });
    const cache = createCache({ name: 'app', tiers: [memoryTier()] });
    expect(cache.status()).toEqual({ memory: 'available' });
  });
});

describe('read path', () => {
  it('reports a miss in every tier of the policy, top down', async () => {
    const cache = threeTiers();
    const events = record(cache);
    const ns = cache.namespace('n', { tiers: ['memory', 'session', 'indexeddb'] });

    await expect(ns.get('k')).resolves.toBeUndefined();

    expect(events).toEqual([
      { type: 'miss', namespace: 'n', key: 'k', tier: 'memory', reason: 'absent' },
      { type: 'miss', namespace: 'n', key: 'k', tier: 'session', reason: 'absent' },
      { type: 'miss', namespace: 'n', key: 'k', tier: 'indexeddb', reason: 'absent' },
    ]);
  });

  it('returns a memory hit without reading lower tiers', async () => {
    const cache = threeTiers();
    const ns = cache.namespace('n', { tiers: ['memory', 'session', 'indexeddb'] });
    await ns.set('k', 'v');
    const events = record(cache);

    await expect(ns.get('k')).resolves.toBe('v');

    expect(events).toEqual([
      { type: 'hit', namespace: 'n', key: 'k', tier: 'memory', sizeBytes: 6 },
    ]);
  });

  it('promotes a lower-tier hit into every tier walked above it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    const cache = threeTiers();
    await cache.namespace('n', { tiers: ['indexeddb'] }).set('k', { id: 1 });
    vi.setSystemTime(2_000);
    const events = record(cache);
    const ns = cache.namespace('n', { tiers: ['memory', 'session', 'indexeddb'] });

    await expect(ns.get('k')).resolves.toEqual({ id: 1 });

    // Sized when written, by estimate: that namespace has no session in its policy.
    const sizeBytes = estimateSize({ id: 1 });
    expect(events.map((event) => [event.type, 'tier' in event ? event.tier : undefined])).toEqual([
      ['miss', 'memory'],
      ['miss', 'session'],
      ['hit', 'indexeddb'],
      ['promote', 'memory'],
      ['promote', 'session'],
    ]);
    expect(events[3]).toEqual({
      type: 'promote',
      namespace: 'n',
      key: 'k',
      tier: 'memory',
      from: 'indexeddb',
      sizeBytes,
    });
    expect(ns.getSync('k')).toEqual({ id: 1 });
    expect(
      session
        .tier()(
          'app',
          Object.assign(() => undefined, { has: () => false }),
        )
        .get('n', 'k'),
    ).toMatchObject({ updatedAt: 2_000, value: { id: 1 } });
  });

  it('does not promote into tiers outside the policy', async () => {
    const cache = threeTiers();
    await cache.namespace('n', { tiers: ['indexeddb'] }).set('k', 'v');
    const events = record(cache, ['promote']);

    await cache.namespace('n', { tiers: ['memory', 'indexeddb'] }).get('k');

    expect(events.map((event) => event.type === 'promote' && event.tier)).toEqual(['memory']);
    expect(cache.namespace('n', { tiers: ['session'] }).getSync('k')).toBeUndefined();
  });

  it('skips a promotion target that refuses the entry as too large, without an error', async () => {
    const cache = createCache({
      name: 'app',
      tiers: [memoryTier({ maxBytes: 100, maxEntryBytes: 10 }), indexedDBTier()],
    });
    const events = record(cache, ['promote', 'error']);
    const ns = cache.namespace('n', { tiers: ['memory', 'indexeddb'] });
    const result = await ns.set('k', 'a long value');
    expect(result.stored).toEqual(['indexeddb']);
    events.length = 0;

    await expect(ns.get('k')).resolves.toBe('a long value');

    expect(events).toEqual([]);
  });

  it('reports other promotion failures and keeps going', async () => {
    const broken = scriptedTier('memory', { get: () => undefined });
    const cache = createCache({ name: 'app', tiers: [broken.config, indexedDBTier()] });
    await cache.namespace('n', { tiers: ['indexeddb'] }).set('k', 'v');
    const events = record(cache, ['hit', 'promote', 'error']);

    await expect(cache.namespace('n', { tiers: ['memory', 'indexeddb'] }).get('k')).resolves.toBe(
      'v',
    );

    expect(events.map((event) => event.type)).toEqual(['hit', 'error']);
    const error = events[1]?.type === 'error' ? events[1].error : undefined;
    expect(error).toMatchObject({ code: 'STORAGE_FAILED', tier: 'memory', namespace: 'n' });
  });

  it('treats a tier read failure as a miss and reports it', async () => {
    const broken = scriptedTier('memory');
    const cache = createCache({ name: 'app', tiers: [broken.config, sessionTier()] });
    const events = record(cache, ['miss', 'error']);
    const ns = cache.namespace('n', { tiers: ['memory', 'session'] });
    await cache.namespace('n', { tiers: ['session'] }).set('k', 'v');
    events.length = 0;

    await expect(ns.get('k')).resolves.toBe('v');

    // The read fails, then so does the promotion into the same tier.
    expect(events.map((event) => event.type)).toEqual(['error', 'miss', 'error']);
    expect(events[1]).toMatchObject({ tier: 'memory', reason: 'error' });
  });

  it('reports a corrupt record as an invalid miss and a newer format as a newer miss', async () => {
    const cache = threeTiers();
    const events = record(cache, ['miss', 'error']);
    const ns = cache.namespace('n', { tiers: ['indexeddb'] });
    await indexeddb.writeRaw?.('app', 'n', 'corrupt', 'corrupt');
    await indexeddb.writeRaw?.('app', 'n', 'newer', 'newer');

    await expect(ns.get('corrupt')).resolves.toBeUndefined();
    await expect(ns.get('newer')).resolves.toBeUndefined();

    expect(events.map((event) => event.type)).toEqual(['error', 'miss', 'miss']);
    expect(events[0]).toMatchObject({ error: { code: 'CORRUPT_ENTRY' } });
    expect(events[1]).toMatchObject({ key: 'corrupt', reason: 'invalid' });
    expect(events[2]).toMatchObject({ key: 'newer', reason: 'newer' });
  });

  it('misses on another schema version and leaves the entry in place', async () => {
    const cache = threeTiers();
    await cache.namespace('n', { tiers: ['memory'], version: 2 }).set('k', 'v2');
    const events = record(cache, ['miss']);

    await expect(cache.namespace('n', { tiers: ['memory'] }).get('k')).resolves.toBeUndefined();
    await expect(
      cache.namespace('n', { tiers: ['memory'], version: 3 }).get('k'),
    ).resolves.toBeUndefined();

    expect(events.map((event) => event.type === 'miss' && event.reason)).toEqual([
      'newer',
      'invalid',
    ]);
    await expect(cache.namespace('n', { tiers: ['memory'], version: 2 }).get('k')).resolves.toBe(
      'v2',
    );
  });

  it('answers has from the read path', async () => {
    const ns = threeTiers().namespace('n', { tiers: ['memory', 'indexeddb'] });
    await ns.set('k', 0);
    await expect(ns.has('k')).resolves.toBe(true);
    await expect(ns.has('other')).resolves.toBe(false);
  });
});

describe('getSync', () => {
  it('reads the sync tiers only and promotes a session hit into memory', async () => {
    const cache = threeTiers();
    await cache.namespace('n', { tiers: ['session'] }).set('s', 'from session');
    await cache.namespace('n', { tiers: ['indexeddb'] }).set('i', 'from indexeddb');
    const events = record(cache);
    const ns = cache.namespace('n', { tiers: ['memory', 'session', 'indexeddb'] });

    expect(ns.getSync('s')).toBe('from session');
    expect(ns.getSync('i')).toBeUndefined();

    expect(events.map((event) => [event.type, 'tier' in event ? event.tier : undefined])).toEqual([
      ['miss', 'memory'],
      ['hit', 'session'],
      ['promote', 'memory'],
      ['miss', 'memory'],
      ['miss', 'session'],
    ]);
  });

  it('throws instead of rejecting', () => {
    const ns = threeTiers().namespace('n', { tiers: ['memory'] });
    expect(() => ns.getSync(1 as never)).toThrow(TypeError);
  });
});

describe('expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
  });

  it('removes an expired copy on read and reports it', async () => {
    const cache = threeTiers();
    const ns = cache.namespace('n', { tiers: ['memory', 'indexeddb'], ttlMs: 1_000 });
    await ns.set('k', 'v');
    vi.setSystemTime(1_000);
    const events = record(cache, ['miss', 'expire']);

    await expect(ns.get('k')).resolves.toBeUndefined();

    expect(events).toEqual([
      { type: 'expire', namespace: 'n', key: 'k', tier: 'memory' },
      { type: 'miss', namespace: 'n', key: 'k', tier: 'memory', reason: 'expired' },
      { type: 'expire', namespace: 'n', key: 'k', tier: 'indexeddb' },
      { type: 'miss', namespace: 'n', key: 'k', tier: 'indexeddb', reason: 'expired' },
    ]);
    await expect(ns.keys()).resolves.toEqual([]);
  });

  it('reports an expired copy that could not be removed', () => {
    vi.setSystemTime(0);
    const expiredEnvelope = {
      format: 1 as const,
      value: 'v',
      schemaVersion: 1,
      updatedAt: 0,
      sizeBytes: 2,
      freshUntil: 1,
      expiresAt: 1,
    };
    const broken = scriptedTier('memory', { get: () => expiredEnvelope });
    vi.setSystemTime(5);
    const cache = createCache({ name: 'app', tiers: [broken.config] });
    const events = record(cache, ['error', 'expire', 'miss']);

    expect(cache.namespace('n', { tiers: ['memory'] }).getSync('k')).toBeUndefined();

    expect(events.map((event) => event.type)).toEqual(['error', 'expire', 'miss']);
  });

  it('misses a stale copy within its stale window and keeps it', async () => {
    const cache = threeTiers();
    const ns = cache.namespace('n', { tiers: ['memory'], ttlMs: 1_000 });
    await ns.set('k', 'v', { staleWhileRevalidateMs: 1_000 });
    vi.setSystemTime(1_500);
    const events = record(cache, ['miss']);

    await expect(ns.get('k')).resolves.toBeUndefined();

    expect(events).toEqual([
      { type: 'miss', namespace: 'n', key: 'k', tier: 'memory', reason: 'stale' },
    ]);
    await expect(ns.keys()).resolves.toEqual(['k']);
  });

  it('lets set options override the namespace defaults', async () => {
    const cache = threeTiers();
    const events = record(cache, ['set']);
    const ns = cache.namespace('n', { tiers: ['memory'], ttlMs: 1_000 });

    await ns.set('a', 'v');
    await ns.set('b', 'v', { ttlMs: 50, staleWhileRevalidateMs: 10 });
    await ns.set('c', 'v', { ttlMs: Infinity });

    expect(events).toEqual([
      expect.objectContaining({ key: 'a', freshUntil: 1_000, expiresAt: 1_000 }),
      expect.objectContaining({ key: 'b', freshUntil: 50, expiresAt: 60 }),
      expect.not.objectContaining({ freshUntil: expect.anything() as unknown }),
    ]);
  });
});

describe('write path', () => {
  it('writes every available tier of the policy and reports each', async () => {
    const cache = threeTiers();
    const events = record(cache, ['set']);
    const ns = cache.namespace('n', { tiers: ['indexeddb', 'memory', 'session'] });

    await expect(ns.set('k', 'value')).resolves.toEqual({
      stored: ['memory', 'session', 'indexeddb'],
      errors: [],
    });

    const sizeBytes = 2 * JSON.stringify('value').length;
    expect(events).toEqual(
      (['memory', 'session', 'indexeddb'] as const).map((tier) => ({
        type: 'set',
        namespace: 'n',
        key: 'k',
        tier,
        sizeBytes,
        reason: 'set',
      })),
    );
  });

  it('writes sync tiers before set returns', () => {
    const ns = threeTiers().namespace('n', { tiers: ['memory', 'indexeddb'] });
    void ns.set('k', 'v');
    expect(ns.getSync('k')).toBe('v');
  });

  it('orders an async read after the write queued before it', async () => {
    const ns = threeTiers().namespace('n', { tiers: ['indexeddb'] });
    void ns.set('k', 'first');
    const pending = ns.set('k', 'second');
    await expect(ns.get('k')).resolves.toBe('second');
    await pending;
  });

  it('sizes entries by their JSON text with session in the policy, by estimate otherwise', async () => {
    const cache = threeTiers();
    const events = record(cache, ['set']);
    const value = { list: [1, 2, 3], label: 'abc' };

    await cache.namespace('a', { tiers: ['memory', 'session'] }).set('k', value);
    await cache.namespace('b', { tiers: ['memory'] }).set('k', value);

    expect(events.map((event) => event.type === 'set' && event.sizeBytes)).toEqual([
      2 * JSON.stringify(value).length,
      2 * JSON.stringify(value).length,
      estimateSize(value),
    ]);
  });

  it('rejects values that are not JSON-safe in a session namespace', async () => {
    const ns = threeTiers().namespace('n', { tiers: ['session'] });
    await expect(ns.set('k', 1n)).rejects.toThrow(TypeError);
    await expect(ns.set('k', Symbol('s'))).rejects.toThrow(TypeError);
    const other = threeTiers().namespace('n', { tiers: ['memory'] });
    await expect(other.set('k', 1n)).resolves.toMatchObject({ stored: ['memory'] });
  });

  it.each([
    ['an undefined value', 'k', undefined, undefined],
    ['a key that is not a string', 1, 'v', undefined],
    ['options that are not an object', 'k', 'v', 'ttl'],
    ['a negative ttl', 'k', 'v', { ttlMs: -1 }],
    ['a stale window that is not a number', 'k', 'v', { staleWhileRevalidateMs: null }],
  ])('rejects %s', async (_, key, value, options) => {
    const ns = threeTiers().namespace('n', { tiers: ['memory'] });
    await expect(ns.set(key as never, value as never, options as never)).rejects.toThrow(TypeError);
  });

  it('deletes the copy of a tier that refuses the write and collects its error', async () => {
    const cache = createCache({
      name: 'app',
      tiers: [memoryTier({ maxBytes: 1_000, maxEntryBytes: 20 }), sessionTier()],
    });
    const events = record(cache, ['set', 'error']);
    const ns = cache.namespace('n', { tiers: ['memory', 'session'] });
    await ns.set('k', 'short');
    events.length = 0;

    const result = await ns.set('k', 'a value too large for memory');

    expect(result.stored).toEqual(['session']);
    expect(result.errors.map((error) => [error.code, error.tier])).toEqual([
      ['ENTRY_TOO_LARGE', 'memory'],
    ]);
    expect(events.map((event) => event.type)).toEqual(['error', 'set']);
    expect(cache.namespace('n', { tiers: ['memory'] }).getSync('k')).toBeUndefined();
    expect(ns.getSync('k')).toBe('a value too large for memory');
  });

  it('collects async write failures and removes that tier copy', async () => {
    const cache = threeTiers();
    const ns = cache.namespace('n', { tiers: ['memory', 'indexeddb'] });
    await ns.set('k', 'old');
    indexeddb.failWrites?.(1, 'other');

    const result = await ns.set('k', 'new');

    expect(result.stored).toEqual(['memory']);
    expect(result.errors).toEqual([expect.objectContaining({ code: 'STORAGE_FAILED' })]);
    await expect(cache.namespace('n', { tiers: ['indexeddb'] }).get('k')).resolves.toBeUndefined();
  });

  it('throws a CacheWriteError when no tier stored the entry', async () => {
    const cache = threeTiers();
    const ns = cache.namespace('n', { tiers: ['session'] });
    session.failWrites?.(1, 'other');

    const error: unknown = await ns.set('k', 'v').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CacheWriteError);
    expect(error).toMatchObject({ namespace: 'n', key: 'k' });
    expect((error as CacheWriteError).errors.map((cause) => cause.code)).toEqual([
      'STORAGE_FAILED',
    ]);
  });

  it('turns a non-CacheError tier failure into STORAGE_FAILED with the cause', async () => {
    const broken = scriptedTier('memory');
    const cache = createCache({ name: 'app', tiers: [broken.config, sessionTier()] });
    const result = await cache.namespace('n', { tiers: ['memory', 'session'] }).set('k', 'v');
    expect(result.errors[0]).toMatchObject({
      code: 'STORAGE_FAILED',
      tier: 'memory',
      namespace: 'n',
      key: 'k',
      cause: new Error('memory broke'),
    });
  });

  it('skips tiers that are unavailable', async () => {
    const down = scriptedTier('session', { status: 'unavailable' });
    const cache = createCache({ name: 'app', tiers: [memoryTier(), down.config] });
    await expect(
      cache.namespace('n', { tiers: ['memory', 'session'] }).set('k', 'v'),
    ).resolves.toEqual({ stored: ['memory'], errors: [] });
    expect(cache.status()).toEqual({ memory: 'available', session: 'unavailable' });
  });
});

describe('a read overtaken by a write', () => {
  it('returns its value but promotes nothing', async () => {
    const cache = threeTiers();
    await cache.namespace('n', { tiers: ['indexeddb'] }).set('k', 'old');
    const ns = cache.namespace('n', { tiers: ['memory', 'indexeddb'] });
    const events = record(cache, ['promote']);

    const read = ns.get('k');
    const write = cache.namespace('n', { tiers: ['memory'] }).set('k', 'new');

    await expect(read).resolves.toBe('old');
    await write;
    expect(events).toEqual([]);
    expect(ns.getSync('k')).toBe('new');
  });

  it('promotes nothing after a clear of its namespace or the cache', async () => {
    const cache = threeTiers();
    await cache.namespace('n', { tiers: ['indexeddb'] }).set('k', 'v');
    const ns = cache.namespace('n', { tiers: ['memory', 'indexeddb'] });
    const events = record(cache, ['promote']);

    const first = ns.get('k');
    void cache.namespace('other', { tiers: ['memory'] }).clear();
    void cache.namespace('n', { tiers: ['memory'] }).clear();
    await first;
    await cache.namespace('n', { tiers: ['indexeddb'] }).set('k', 'v');
    const second = ns.get('k');
    void cache.clear();
    await second;

    expect(events).toEqual([]);
  });
});

describe('delete, clear and keys', () => {
  it('deletes a key from every tier of the policy', async () => {
    const cache = threeTiers();
    const ns = cache.namespace('n', { tiers: ['memory', 'session', 'indexeddb'] });
    await ns.set('k', 'v');
    const events = record(cache, ['delete']);

    await ns.delete('k');

    expect(events).toEqual(
      (['memory', 'session', 'indexeddb'] as const).map((tier) => ({
        type: 'delete',
        namespace: 'n',
        key: 'k',
        tier,
        reason: 'delete',
      })),
    );
    await expect(ns.has('k')).resolves.toBe(false);
  });

  it('clears one namespace in every tier, whatever its policy', async () => {
    const cache = threeTiers();
    await cache.namespace('a', { tiers: ['memory', 'indexeddb'] }).set('k', 'v');
    await cache.namespace('b', { tiers: ['memory', 'indexeddb'] }).set('k', 'v');
    const events = record(cache, ['clear']);

    await cache.namespace('a', { tiers: ['memory'] }).clear();

    expect(events).toEqual(
      (['memory', 'session', 'indexeddb'] as const).map((tier) => ({
        type: 'clear',
        namespace: 'a',
        tier,
        reason: 'clear',
      })),
    );
    await expect(cache.namespace('a', { tiers: ['indexeddb'] }).keys()).resolves.toEqual([]);
    await expect(cache.namespace('b', { tiers: ['indexeddb'] }).keys()).resolves.toEqual(['k']);
  });

  it('clears the whole cache', async () => {
    const cache = threeTiers();
    const ns = cache.namespace('n', { tiers: ['memory', 'session', 'indexeddb'] });
    await ns.set('k', 'v');
    const events = record(cache, ['clear']);

    await cache.clear();

    expect(events).toEqual(
      (['memory', 'session', 'indexeddb'] as const).map((tier) => ({
        type: 'clear',
        tier,
        reason: 'clear',
      })),
    );
    await expect(ns.keys()).resolves.toEqual([]);
  });

  it('orders a clear between the writes queued around it', async () => {
    const ns = threeTiers().namespace('n', { tiers: ['indexeddb'] });
    void ns.set('a', 1);
    void ns.clear();
    void ns.set('b', 2);
    await expect(ns.keys()).resolves.toEqual(['b']);
  });

  it('lists the union of keys over the policy', async () => {
    const cache = threeTiers();
    await cache.namespace('n', { tiers: ['memory'] }).set('a', 1);
    await cache.namespace('n', { tiers: ['memory', 'indexeddb'] }).set('b', 2);
    await cache.namespace('n', { tiers: ['indexeddb'] }).set('c', 3);

    const keys = await cache.namespace('n', { tiers: ['memory', 'indexeddb'] }).keys();

    expect(keys.sort()).toEqual(['a', 'b', 'c']);
  });

  it('throws a CacheWriteError when a removal fails, after the other tiers', async () => {
    const broken = scriptedTier('memory');
    const cache = createCache({ name: 'app', tiers: [broken.config, sessionTier()] });
    const events = record(cache, ['delete', 'clear', 'error']);
    const ns = cache.namespace('n', { tiers: ['memory', 'session'] });

    await expect(ns.delete('k')).rejects.toBeInstanceOf(CacheWriteError);
    await expect(cache.clear()).rejects.toBeInstanceOf(CacheWriteError);

    expect(events.map((event) => [event.type, 'tier' in event ? event.tier : undefined])).toEqual([
      ['error', 'memory'],
      ['delete', 'session'],
      ['error', 'memory'],
      ['clear', 'session'],
    ]);
  });

  it('rejects an async removal failure the same way', async () => {
    const failing: TierAdapter<false> = {
      name: 'indexeddb',
      sync: false,
      status: 'available',
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      delete: () => Promise.reject(new Error('delete broke')),
      clear: () => Promise.resolve(),
      keys: () => Promise.reject(new Error('keys broke')),
      close: () => undefined,
    };
    const cache = createCache({ name: 'app', tiers: [tierConfig('indexeddb', () => failing)] });
    const errors = record(cache, ['error']);
    const ns = cache.namespace('n', { tiers: ['indexeddb'] });

    await expect(ns.delete('k')).rejects.toBeInstanceOf(CacheWriteError);
    await expect(ns.keys()).resolves.toEqual([]);
    expect(errors).toHaveLength(2);
  });

  it('reports a failing keys call without rejecting', async () => {
    const broken = scriptedTier('memory');
    const cache = createCache({ name: 'app', tiers: [broken.config, sessionTier()] });
    await cache.namespace('n', { tiers: ['session'] }).set('k', 'v');
    const errors = record(cache, ['error']);

    await expect(cache.namespace('n', { tiers: ['memory', 'session'] }).keys()).resolves.toEqual([
      'k',
    ]);
    expect(errors).toHaveLength(1);
  });
});

describe('sweep', () => {
  function sweeping(sweep: () => void = () => undefined) {
    const spy = vi.fn(sweep);
    const tier = scriptedTier('memory', { sweep: spy });
    return { spy, config: tier.config };
  }

  it('sweeps once after creating the cache, then every sweepIntervalMs', async () => {
    vi.useFakeTimers();
    const { spy, config } = sweeping();
    createCache({ name: 'app', tiers: [config], sweepIntervalMs: 1_000 });
    expect(spy).not.toHaveBeenCalled();

    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('defaults to five minutes and stops on close', async () => {
    vi.useFakeTimers();
    const { spy, config } = sweeping();
    const cache = createCache({ name: 'app', tiers: [config] });
    await settle();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(spy).toHaveBeenCalledTimes(2);

    cache.close();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts no timer with a zero interval or without a sweeping tier', async () => {
    vi.useFakeTimers();
    const { spy, config } = sweeping();
    createCache({ name: 'a', tiers: [config], sweepIntervalMs: 0 });
    createCache({ name: 'b', tiers: [memoryTier()] });
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports sweep failures, thrown or rejected', async () => {
    const thrown = sweeping(() => {
      throw new Error('sweep broke');
    });
    const rejecting: TierAdapter<false> = {
      name: 'indexeddb',
      sync: false,
      status: 'available',
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      keys: () => Promise.resolve([]),
      sweep: () => Promise.reject(new Error('sweep broke')),
      close: () => undefined,
    };
    const rejected = { config: tierConfig('indexeddb', () => rejecting) };
    const errors: CacheEvent[] = [];
    for (const { config } of [thrown, rejected]) {
      const cache = createCache({ name: 'app', tiers: [config], sweepIntervalMs: 0 });
      cache.on('error', (event) => errors.push(event));
    }
    await settle();
    expect(errors).toEqual([
      expect.objectContaining({ tier: 'memory', error: expect.any(CacheError) as unknown }),
      expect.objectContaining({ tier: 'indexeddb', error: expect.any(CacheError) as unknown }),
    ]);
  });

  it('lets the async reference tier drop expired entries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const cache = threeTiers();
    await cache.namespace('n', { tiers: ['indexeddb'], ttlMs: 10 }).set('k', 'v');
    vi.setSystemTime(10);
    const fresh = threeTiers();
    const events = record(fresh, ['expire']);
    await settle();
    expect(events).toEqual([{ type: 'expire', namespace: 'n', key: 'k', tier: 'indexeddb' }]);
  });
});

describe('tier status', () => {
  it('reports a tier that turns unavailable once, after the operation', async () => {
    let status: TierStatus = 'available';
    const flaky = scriptedTier('session', {
      get status() {
        return status;
      },
      set: () => {
        status = 'unavailable';
        throw new Error('storage disabled');
      },
    });
    const cache = createCache({ name: 'app', tiers: [memoryTier(), flaky.config] });
    const errors: CacheError[] = [];
    cache.on('error', (event) => errors.push(event.error));
    const ns = cache.namespace('n', { tiers: ['memory', 'session'] });

    const write = ns.set('k', 'v');
    expect(errors.map((error) => error.code)).toEqual(['STORAGE_FAILED']);
    await write;
    await settle();
    expect(errors.map((error) => error.code)).toEqual(['STORAGE_FAILED', 'TIER_UNAVAILABLE']);

    await ns.set('k', 'v');
    expect(cache.status()).toEqual({ memory: 'available', session: 'unavailable' });
    await settle();
    expect(errors).toHaveLength(2);
  });
});

describe('events', () => {
  it('stops calling a handler after off or its unsubscribe function', async () => {
    const ns = threeTiers();
    const handler = vi.fn();
    const unsubscribe = ns.on('miss', handler);
    const other = vi.fn();
    ns.on('miss', other);
    const n = ns.namespace('n', { tiers: ['memory'] });

    await n.get('a');
    unsubscribe();
    ns.off('miss', other);
    await n.get('b');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
  });
});

describe('close', () => {
  it('rejects later calls with CLOSED and closes every adapter once', async () => {
    const closeSync = vi.fn();
    const memory = scriptedTier('memory', { close: closeSync });
    const closeAsync = vi.fn();
    const asyncAdapter: TierAdapter<false> = {
      name: 'indexeddb',
      sync: false,
      status: 'available',
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      keys: () => Promise.resolve([]),
      close: closeAsync,
    };
    const cache = createCache({
      name: 'app',
      tiers: [memory.config, tierConfig('indexeddb', () => asyncAdapter)],
    });
    const ns = cache.namespace('n', { tiers: ['indexeddb'] });
    const write = ns.set('k', 'v');

    cache.close();
    cache.close();

    expect(closeSync).toHaveBeenCalledTimes(1);
    expect(closeAsync).not.toHaveBeenCalled();
    await write;
    await settle();
    expect(closeAsync).toHaveBeenCalledTimes(1);

    for (const call of [
      () => ns.get('k'),
      () => ns.has('k'),
      () => ns.set('k', 'v'),
      () => ns.delete('k'),
      () => ns.keys(),
      () => ns.clear(),
      () => cache.clear(),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'CLOSED' });
    }
    expect(() => ns.getSync('k')).toThrow(CacheError);
  });

  it('promotes nothing from a read that was in flight', async () => {
    const cache = threeTiers();
    await cache.namespace('n', { tiers: ['indexeddb'] }).set('k', 'v');
    const events = record(cache, ['promote']);
    const read = cache.namespace('n', { tiers: ['memory', 'indexeddb'] }).get('k');
    cache.close();
    await expect(read).resolves.toBe('v');
    expect(events).toEqual([]);
  });
});

describe('not yet implemented', () => {
  it('rejects getOrSet until #25', async () => {
    const ns = threeTiers().namespace('n', { tiers: ['memory'] });
    await expect(ns.getOrSet('k', () => Promise.resolve('v'))).rejects.toThrow('#25');
  });
});

describe('types', () => {
  interface Ticket {
    id: string;
  }

  it('infer the value type from the namespace', async () => {
    const cache = createCache({ name: 'app', tiers: [memoryTier()] });
    const tickets = cache.namespace<Ticket>('tickets', { tiers: ['memory'] });
    expectTypeOf(cache).toEqualTypeOf<TieredCache>();
    expectTypeOf(tickets).toEqualTypeOf<CacheNamespace<Ticket>>();

    await tickets.set('t1', { id: 't1' });
    const ticket = await tickets.get('t1');
    expectTypeOf(ticket).toEqualTypeOf<Ticket | undefined>();
    expect(ticket).toEqual({ id: 't1' });
    expectTypeOf(memoryTier).returns.toEqualTypeOf<TierConfig<'memory'>>();
  });
});
