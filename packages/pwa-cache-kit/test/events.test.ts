// Acceptance tests of the events API (#23) over the real memory and IndexedDB tiers.
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCache,
  indexedDBTier,
  memoryTier,
  type CacheEvent,
  type CacheEventType,
  type TieredCache,
} from '../src/index.js';
import type { TierEmit } from '../src/tier.js';
import { adapterBuilder, tierConfig } from '../src/tier-config.js';

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

/** The event types a tier emits itself (ADR-0002 section 17). */
const TIER_EVENTS = ['expire', 'evict', 'error'] as const;

let caches: TieredCache[] = [];

function cache(tiers = [memoryTier(), indexedDBTier()]): TieredCache {
  const created = createCache({ name: 'app', tiers, sweepIntervalMs: 0 });
  caches.push(created);
  return created;
}

/** Records every event of `target` in dispatch order. */
function record(target: TieredCache): CacheEvent[] {
  const events: CacheEvent[] = [];
  for (const type of ALL_EVENTS) {
    target.on(type, (event) => {
      events.push(event);
    });
  }
  return events;
}

/** The events as `type(tier)`, for checking their order. */
function sequence(events: readonly CacheEvent[]): string[] {
  return events.map((event) => `${event.type}(${event.tier ?? ''})`);
}

beforeEach(() => {
  // A worker scope is enough for the cache to count as running in a browser context.
  vi.stubGlobal('importScripts', () => undefined);
  vi.stubGlobal('indexedDB', new FakeIDBFactory());
  vi.stubGlobal('IDBKeyRange', FakeIDBKeyRange);
});

afterEach(() => {
  for (const created of caches) created.close();
  caches = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('events', () => {
  it('reports a memory miss served by IndexedDB as miss, hit, then promote', async () => {
    const policy = { tiers: ['memory', 'indexeddb'], ttlMs: 60_000 } as const;
    await cache().namespace('tickets', policy).set('t1', { seat: '12A' });

    // A second cache starts with an empty memory tier over the same database.
    const reader = cache();
    const events = record(reader);
    const value = await reader.namespace('tickets', policy).get('t1');

    expect(value).toEqual({ seat: '12A' });
    expect(sequence(events)).toEqual(['miss(memory)', 'hit(indexeddb)', 'promote(memory)']);
    const [miss, hit, promote] = events;
    expect(miss).toEqual({
      type: 'miss',
      namespace: 'tickets',
      key: 't1',
      tier: 'memory',
      reason: 'absent',
    });
    expect(hit).toMatchObject({ type: 'hit', namespace: 'tickets', key: 't1' });
    expect(promote).toMatchObject({ type: 'promote', namespace: 'tickets', key: 't1' });
    if (hit?.type !== 'hit' || promote?.type !== 'promote') throw new Error('unexpected events');
    expect(promote.from).toBe('indexeddb');
    expect(promote.sizeBytes).toBe(hit.sizeBytes);
    expect(hit.sizeBytes).toBeGreaterThan(0);
    // The copy keeps its expiry, which the inspector turns into TTL remaining.
    expect(hit.freshUntil).toBeGreaterThan(Date.now());
    expect(promote.freshUntil).toBe(hit.freshUntil);
    expect(promote.expiresAt).toBe(hit.expiresAt);

    events.length = 0;
    await reader.namespace('tickets', policy).get('t1');
    expect(sequence(events)).toEqual(['hit(memory)']);
  });

  it('reports writes, removals and clears for each tier, top down', async () => {
    const target = cache();
    const events = record(target);
    const tickets = target.namespace('tickets', { tiers: ['memory', 'indexeddb'] });

    await tickets.set('t1', 'v');
    expect(events).toMatchObject([
      { type: 'set', namespace: 'tickets', key: 't1', tier: 'memory', reason: 'set' },
      { type: 'set', namespace: 'tickets', key: 't1', tier: 'indexeddb', reason: 'set' },
    ]);
    expect(events[0]).not.toHaveProperty('freshUntil');

    events.length = 0;
    await tickets.delete('t1');
    await tickets.clear();
    await target.clear();
    expect(sequence(events)).toEqual([
      'delete(memory)',
      'delete(indexeddb)',
      'clear(memory)',
      'clear(indexeddb)',
      'clear(memory)',
      'clear(indexeddb)',
    ]);
    expect(events[0]).toMatchObject({ reason: 'delete' });
    expect(events[2]).toMatchObject({ namespace: 'tickets', reason: 'clear' });
    expect(events[4]).not.toHaveProperty('namespace');
  });

  it('reports expired copies and budget evictions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const target = cache([memoryTier({ maxBytes: 100, maxEntryBytes: 100 })]);
    const events = record(target);
    const ns = target.namespace('n', { tiers: ['memory'], ttlMs: 1_000 });

    await ns.set('old', 'x'.repeat(20));
    vi.setSystemTime(Date.now() + 2_000);
    await expect(ns.get('old')).resolves.toBeUndefined();
    expect(sequence(events.slice(1))).toEqual(['expire(memory)', 'miss(memory)']);
    expect(events[2]).toMatchObject({ reason: 'expired' });

    events.length = 0;
    await ns.set('a', 'x'.repeat(20));
    await ns.set('b', 'x'.repeat(20));
    await ns.set('c', 'x'.repeat(20));
    const evicted = events.filter((event) => event.type === 'evict');
    expect(evicted).toMatchObject([{ key: 'a', tier: 'memory', reason: 'budget' }]);
  });

  it('reports a tier that fails a write as an error event, next to the write result', async () => {
    const target = cache();
    const errors: CacheEvent[] = [];
    target.on('error', (event) => errors.push(event));
    const ns = target.namespace('n', { tiers: ['memory', 'indexeddb'] });

    // Memory keeps any value; IndexedDB cannot structured-clone a function.
    const result = await ns.set('k', () => undefined);
    expect(result.stored).toEqual(['memory']);
    expect(errors).toEqual([
      { type: 'error', namespace: 'n', key: 'k', tier: 'indexeddb', error: result.errors[0] },
    ]);
    expect(result.errors[0]).toMatchObject({ code: 'SERIALIZATION_FAILED', tier: 'indexeddb' });
  });

  it('tells tiers which types have listeners, so no payload is built for the others', () => {
    let emit: TierEmit | undefined;
    const create = adapterBuilder(memoryTier());
    if (!create) throw new Error('memoryTier has no adapter builder');
    const target = cache([
      tierConfig('memory', (name, tierEmit) => {
        emit = tierEmit;
        return create(name, tierEmit);
      }),
    ]);

    const listened = () => TIER_EVENTS.filter((type) => emit?.has(type));

    expect(listened()).toEqual([]);
    const handler = (): void => undefined;
    const unsubscribe = target.on('evict', handler);
    target.on('hit', handler);
    target.on('error', handler);
    expect(listened()).toEqual(['evict', 'error']);
    unsubscribe();
    target.off('error', handler);
    expect(listened()).toEqual([]);
  });

  it('runs handlers synchronously, before the operation settles', async () => {
    const target = cache([memoryTier()]);
    const calls: string[] = [];
    target.on('set', () => calls.push('first'));
    target.on('set', () => calls.push('second'));
    const write = target.namespace('n', { tiers: ['memory'] }).set('k', 'v');
    expect(calls).toEqual(['first', 'second']);
    await write;
  });

  it('keeps the operation and later handlers going when a handler throws', async () => {
    const reportError = vi.fn();
    vi.stubGlobal('reportError', reportError);
    const target = cache([memoryTier()]);
    const failure = new Error('handler broke');
    target.on('set', () => {
      throw failure;
    });
    const after = vi.fn();
    target.on('set', after);

    await expect(target.namespace('n', { tiers: ['memory'] }).set('k', 'v')).resolves.toEqual({
      stored: ['memory'],
      errors: [],
    });
    expect(after).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(failure);
  });
});
