import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryAdapter } from '../src/memory.js';
import type { Envelope, TierEmit, TierEvent } from '../src/tier.js';
import { runTierConformance } from './conformance/tier-conformance.js';

runTierConformance({ name: 'memory', tier: memoryAdapter });

describe('memory adapter', () => {
  let events: TierEvent[] = [];
  const emit: TierEmit = Object.assign(
    (event: TierEvent) => {
      events.push(event);
    },
    { has: () => true },
  );

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    events = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function entry(sizeBytes: number): Envelope {
    return { format: 1, value: 'v', schemaVersion: 1, updatedAt: Date.now(), sizeBytes };
  }

  it('evicts the least recently used entry, counting a read as a use', () => {
    const adapter = memoryAdapter({ maxBytes: 100, maxEntryBytes: 50 })('c', emit);
    adapter.set('ns', 'a', entry(30));
    adapter.set('ns', 'b', entry(30));
    adapter.set('ns', 'c', entry(30));

    adapter.get('ns', 'a');
    adapter.set('ns', 'd', entry(30));

    expect(adapter.keys('ns').sort()).toEqual(['a', 'c', 'd']);
    expect(events).toEqual([
      { type: 'evict', namespace: 'ns', key: 'b', tier: 'memory', sizeBytes: 30, reason: 'budget' },
    ]);
  });

  it('builds no event when nobody listens', () => {
    const silent: TierEmit = Object.assign(vi.fn(), { has: () => false });
    const adapter = memoryAdapter({ maxBytes: 20, maxEntryBytes: 10 })('c', silent);
    adapter.set('ns', 'expired', { ...entry(10), expiresAt: Date.now() });
    adapter.set('ns', 'live', entry(10));
    adapter.set('ns', 'new', entry(10));
    adapter.set('ns', 'newer', entry(10));

    expect(adapter.keys('ns').sort()).toEqual(['new', 'newer']);
    expect(silent).not.toHaveBeenCalled();
  });

  it('keeps the value by reference', () => {
    const adapter = memoryAdapter()('c', emit);
    const value = { seats: [1, 2] };
    adapter.set('ns', 'k', { ...entry(10), value });

    const stored = adapter.get('ns', 'k');

    expect(typeof stored === 'object' && stored.value).toBe(value);
  });

  it('splits keys holding the separator at the first one, which names never contain', () => {
    const adapter = memoryAdapter({ maxBytes: 20, maxEntryBytes: 10 })('c', emit);
    adapter.set('ns', 'x\u0000y', entry(10));
    adapter.set('ns', 'z', entry(10));
    adapter.set('ns', 'w', entry(10));

    expect(adapter.keys('ns').sort()).toEqual(['w', 'z']);
    expect(events).toEqual([
      {
        type: 'evict',
        namespace: 'ns',
        key: 'x\u0000y',
        tier: 'memory',
        sizeBytes: 10,
        reason: 'budget',
      },
    ]);
  });

  it('gives each cache its own entries and drops them on close', () => {
    const tier = memoryAdapter();
    const first = tier('same', emit);
    const second = tier('same', emit);
    first.set('ns', 'k', entry(10));

    expect(second.get('ns', 'k')).toBeUndefined();

    first.close();
    expect(first.keys('ns')).toEqual([]);
    first.set('ns', 'k', entry(10));
    expect(first.keys('ns')).toEqual(['k']);
  });
});
