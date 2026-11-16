import { describe, expect, it } from 'vitest';
import { CacheError } from '../../src/errors.js';
import type { CacheEvent } from '../../src/events.js';
import {
  createModel,
  describeEvent,
  describeTtl,
  EVICTED_MS,
  formatBytes,
  formatDuration,
  type TierCopy,
} from '../../src/inspector/model.js';

const key = { namespace: 'n', key: 'k' } as const;

function copy(fields: Partial<TierCopy> = {}): TierCopy {
  return {
    sizeBytes: 10,
    freshUntil: undefined,
    expiresAt: undefined,
    evictedAt: undefined,
    evictReason: undefined,
    ...fields,
  };
}

describe('createModel', () => {
  it('tracks the copies that set, promote and hit report, with size and expiry', () => {
    const model = createModel(10);
    model.apply({ type: 'set', ...key, tier: 'indexeddb', sizeBytes: 4, reason: 'set' }, 0);
    model.apply({ type: 'hit', ...key, tier: 'indexeddb', sizeBytes: 4, freshUntil: 9 }, 1);
    model.apply(
      { type: 'promote', ...key, tier: 'memory', from: 'indexeddb', sizeBytes: 4, expiresAt: 20 },
      1,
    );
    model.apply(
      { type: 'set', namespace: 'a', key: 'z', tier: 'memory', sizeBytes: 1, reason: 'load' },
      2,
    );

    expect(model.rows()).toEqual([
      { namespace: 'a', key: 'z', tiers: { memory: copy({ sizeBytes: 1 }) } },
      {
        ...key,
        tiers: {
          indexeddb: copy({ sizeBytes: 4, freshUntil: 9 }),
          memory: copy({ sizeBytes: 4, expiresAt: 20 }),
        },
      },
    ]);
  });

  it('sorts keys of one namespace by key', () => {
    const model = createModel(10);
    for (const name of ['b', 'a']) {
      model.apply(
        { type: 'set', namespace: 'n', key: name, tier: 'memory', sizeBytes: 1, reason: 'set' },
        0,
      );
    }
    expect(model.rows().map((row) => row.key)).toEqual(['a', 'b']);
  });

  it('drops a copy on delete, expire, an absent or invalid miss, and keeps it on other misses', () => {
    const model = createModel(20);
    const set = (tier: 'memory' | 'session' | 'indexeddb'): CacheEvent => ({
      type: 'set',
      ...key,
      tier,
      sizeBytes: 1,
      reason: 'set',
    });
    for (const tier of ['memory', 'session', 'indexeddb'] as const) model.apply(set(tier), 0);

    model.apply({ type: 'miss', ...key, tier: 'memory', reason: 'stale' }, 1);
    model.apply({ type: 'miss', ...key, tier: 'memory', reason: 'newer' }, 1);
    model.apply({ type: 'miss', ...key, tier: 'memory', reason: 'error' }, 1);
    expect(Object.keys(model.rows()[0]?.tiers ?? {})).toEqual(['memory', 'session', 'indexeddb']);

    model.apply({ type: 'miss', ...key, tier: 'memory', reason: 'absent' }, 1);
    model.apply({ type: 'miss', ...key, tier: 'session', reason: 'invalid' }, 1);
    expect(Object.keys(model.rows()[0]?.tiers ?? {})).toEqual(['indexeddb']);

    model.apply({ type: 'expire', ...key, tier: 'indexeddb' }, 2);
    expect(model.rows()).toEqual([]);

    model.apply(set('memory'), 3);
    model.apply({ type: 'delete', ...key, tier: 'memory', reason: 'delete' }, 3);
    model.apply({ type: 'miss', ...key, tier: 'memory', reason: 'absent' }, 3);
    expect(model.rows()).toEqual([]);
  });

  it('clears one namespace or every namespace in a tier', () => {
    const model = createModel(20);
    for (const namespace of ['a', 'b']) {
      for (const tier of ['memory', 'session'] as const) {
        model.apply({ type: 'set', namespace, key: 'k', tier, sizeBytes: 1, reason: 'set' }, 0);
      }
    }
    model.apply({ type: 'clear', namespace: 'a', tier: 'memory', reason: 'clear' }, 1);
    model.apply({ type: 'clear', namespace: 'a', tier: 'session', reason: 'remote' }, 1);
    expect(model.rows().map((row) => row.namespace)).toEqual(['b']);

    model.apply({ type: 'clear', tier: 'memory', reason: 'clear' }, 2);
    expect(model.rows()).toEqual([
      { namespace: 'b', key: 'k', tiers: { session: copy({ sizeBytes: 1 }) } },
    ]);
  });

  it('keeps an evicted copy, marked, until EVICTED_MS have passed', () => {
    const model = createModel(10);
    model.apply(
      { type: 'set', ...key, tier: 'memory', sizeBytes: 5, freshUntil: 50, reason: 'set' },
      0,
    );
    model.apply({ type: 'evict', ...key, tier: 'memory', sizeBytes: 5, reason: 'quota' }, 100);
    model.apply({ type: 'evict', ...key, tier: 'session', sizeBytes: 5, reason: 'budget' }, 200);

    expect(model.rows()[0]?.tiers).toEqual({
      memory: copy({ sizeBytes: 5, freshUntil: 50, evictedAt: 100, evictReason: 'quota' }),
      session: copy({ sizeBytes: 5, evictedAt: 200, evictReason: 'budget' }),
    });
    expect(model.prune(100 + EVICTED_MS - 1)).toBe(false);
    expect(model.prune(100 + EVICTED_MS)).toBe(true);
    expect(Object.keys(model.rows()[0]?.tiers ?? {})).toEqual(['session']);
    expect(model.prune(200 + EVICTED_MS)).toBe(true);
    expect(model.rows()).toEqual([]);
  });

  it('clears the eviction mark when the key is written again', () => {
    const model = createModel(10);
    model.apply({ type: 'evict', ...key, tier: 'memory', sizeBytes: 5, reason: 'budget' }, 0);
    model.apply({ type: 'set', ...key, tier: 'memory', sizeBytes: 6, reason: 'set' }, 1);
    expect(model.rows()[0]?.tiers.memory).toEqual(copy({ sizeBytes: 6 }));
  });

  it('logs every event with increasing ids, keeps the last maxLog, and forgets on request', () => {
    const model = createModel(2);
    const error: CacheEvent = { type: 'error', error: new CacheError('CLOSED', 'closed') };
    model.apply(error, 1);
    model.apply(error, 2);
    model.apply({ type: 'set', ...key, tier: 'memory', sizeBytes: 1, reason: 'set' }, 3);
    expect(model.log().map((entry) => [entry.id, entry.time])).toEqual([
      [2, 2],
      [3, 3],
    ]);

    model.clearLog();
    expect(model.log()).toEqual([]);
    expect(model.rows()).toHaveLength(1);
    model.forgetKeys();
    expect(model.rows()).toEqual([]);
    model.apply(error, 4);
    expect(model.log()[0]?.id).toBe(4);
  });
});

describe('describeTtl', () => {
  it.each([
    [{}, 0, 'fresh, no expiry'],
    [{ freshUntil: 90_000 }, 0, 'fresh for 1m 30s'],
    [{ freshUntil: 10 }, 10, 'stale, kept'],
    [{ freshUntil: 10, expiresAt: 5_010 }, 10, 'stale, expires in 5s'],
    [{ freshUntil: 10, expiresAt: 20 }, 20, 'expired'],
  ])('describes %j at %d as %s', (fields, now, text) => {
    expect(describeTtl(copy(fields), now)).toBe(text);
  });
});

describe('formatDuration and formatBytes', () => {
  it.each([
    [1, '1s'],
    [59_000, '59s'],
    [65_000, '1m 05s'],
    [3_600_000 + 13 * 60_000, '1h 13m'],
    [3 * 86_400_000 + 4 * 3_600_000, '3d 4h'],
  ])('formats %d ms as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it.each([
    [512, '512 B'],
    [1_434, '1.4 KB'],
    [2 * 1024 * 1024, '2.0 MB'],
  ])('formats %d bytes as %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe('describeEvent', () => {
  it.each<[CacheEvent, string]>([
    [{ type: 'hit', ...key, tier: 'session', sizeBytes: 1 }, 'n/k served by session'],
    [{ type: 'miss', ...key, tier: 'memory', reason: 'absent' }, 'n/k not in memory (absent)'],
    [
      { type: 'set', ...key, tier: 'indexeddb', sizeBytes: 2_048, reason: 'load' },
      'n/k stored in indexeddb (load, 2.0 KB)',
    ],
    [
      { type: 'promote', ...key, tier: 'memory', from: 'session', sizeBytes: 1 },
      'n/k copied from session to memory',
    ],
    [{ type: 'delete', ...key, tier: 'memory', reason: 'delete' }, 'n/k deleted from memory'],
    [
      { type: 'delete', ...key, tier: 'memory', reason: 'remote' },
      'n/k deleted from memory (other tab)',
    ],
    [{ type: 'expire', ...key, tier: 'session' }, 'n/k expired in session'],
    [
      { type: 'evict', ...key, tier: 'memory', sizeBytes: 10, reason: 'budget' },
      'n/k evicted from memory (budget, 10 B)',
    ],
    [{ type: 'clear', namespace: 'n', tier: 'session', reason: 'clear' }, 'n cleared in session'],
    [
      { type: 'clear', tier: 'memory', reason: 'remote' },
      'every namespace cleared in memory (other tab)',
    ],
    [
      { type: 'error', error: new CacheError('QUOTA_EXCEEDED', 'full'), tier: 'session', ...key },
      'QUOTA_EXCEEDED in session n k: full',
    ],
    [{ type: 'error', error: new CacheError('CLOSED', 'closed') }, 'CLOSED: closed'],
  ])('describes %j', (event, text) => {
    expect(describeEvent(event)).toBe(text);
  });
});
