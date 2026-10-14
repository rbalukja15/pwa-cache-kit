// The shared TierAdapter conformance suite (ADR-0002 section 17, issue #22). Every tier's test file
// calls runTierConformance once; tier-agnostic behavior is tested here, not per tier.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheError, type CacheErrorCode } from '../../src/errors.js';
import type { CreateTierAdapter, Envelope, TierAdapter, TierEvent } from '../../src/tier.js';
import type { CacheValue, TierOptions } from '../../src/types.js';

/** How the suite builds and drives one tier. */
export interface TierHarness<Sync extends boolean = boolean> {
  /** Shown in the test names. */
  readonly name: string;
  /** The tier factory's role: budget options in, an adapter builder for one cache out. */
  readonly tier: (options?: TierOptions) => CreateTierAdapter<Sync>;
  /**
   * Makes the tier's next `count` entry writes fail with a quota error from its storage. Tiers
   * whose storage has no quota (memory) leave it out, which skips the quota cases.
   */
  readonly failWrites?: (count: number) => void;
  /**
   * Puts a record straight into the tier's storage: one that is not a valid envelope, or a valid
   * envelope of a later format. Tiers that cannot hold such records leave it out.
   */
  readonly writeRaw?: (
    cacheName: string,
    ns: string,
    key: string,
    kind: 'corrupt' | 'newer',
  ) => void | Promise<void>;
  /** Runs after each test, for example to delete databases or clear `sessionStorage`. */
  readonly reset?: () => void | Promise<void>;
}

// A fixed clock: only Date is faked, so storage that relies on real timers keeps working.
const start = Date.UTC(2026, 0, 1);
let cacheCount = 0;

/** Runs the conformance suite against one tier. */
export function runTierConformance(harness: TierHarness): void {
  describe(`TierAdapter conformance: ${harness.name}`, () => {
    let adapters: TierAdapter[] = [];
    let events: TierEvent[] = [];

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(start);
      events = [];
    });

    afterEach(async () => {
      for (const adapter of adapters) adapter.close();
      adapters = [];
      vi.useRealTimers();
      await harness.reset?.();
    });

    /** A new adapter for a cache no other test uses, unless `cacheName` is given. */
    function create(options?: TierOptions, cacheName = `cache${String(++cacheCount)}`) {
      const adapter = harness.tier(options)(cacheName, (event) => events.push(event));
      adapters.push(adapter);
      return adapter;
    }

    /** Writes entries in order, one ms apart, so the first is the least recently written. */
    async function fill(adapter: TierAdapter, ns: string, sizes: Readonly<Record<string, number>>) {
      for (const [key, sizeBytes] of Object.entries(sizes)) {
        vi.advanceTimersByTime(1);
        await adapter.set(ns, key, entry(key, { sizeBytes }));
      }
    }

    /** Eviction runs in `set` for sync tiers and in `sweep` for async ones (ADR-0002 section 7). */
    async function settleBudget(adapter: TierAdapter) {
      if (!adapter.sync) await adapter.sweep?.();
    }

    async function sortedKeys(adapter: TierAdapter, ns: string) {
      return (await adapter.keys(ns)).sort();
    }

    describe('shape', () => {
      it('has a tier name, a sync flag and a status that becomes available', async () => {
        const adapter = create();

        expect(['memory', 'session', 'indexeddb']).toContain(adapter.name);
        expect(typeof adapter.sync).toBe('boolean');
        expect(['pending', 'available']).toContain(adapter.status);
        await adapter.keys('ns');
        expect(adapter.status).toBe('available');
      });

      it('returns results directly when sync and as Promises when async', async () => {
        const adapter = create();
        const results = [
          adapter.set('ns', 'k', entry('v')),
          adapter.get('ns', 'k'),
          adapter.keys('ns'),
          adapter.delete('ns', 'k'),
          adapter.clear('ns'),
          adapter.clear(),
          ...(adapter.sweep ? [adapter.sweep()] : []),
        ];

        for (const result of results) {
          expect(isThenable(result)).toBe(!adapter.sync);
          await result;
        }
      });

      it('throws failures when sync and rejects with them when async', async () => {
        const adapter = create({ maxBytes: 100, maxEntryBytes: 10 });
        const tooLarge = entry('v', { sizeBytes: 11 });

        if (adapter.sync) {
          expect(() => adapter.set('ns', 'k', tooLarge)).toThrow(CacheError);
        } else {
          let result: unknown;
          expect(() => (result = adapter.set('ns', 'k', tooLarge))).not.toThrow();
          await expect(result).rejects.toBeInstanceOf(CacheError);
        }
      });

      it('emits nothing for the calls it is asked to make, failed ones included', async () => {
        const adapter = create({ maxBytes: 100, maxEntryBytes: 10 });

        await adapter.set('ns', 'k', entry('v'));
        await adapter.get('ns', 'k');
        await adapter.get('ns', 'missing');
        await adapter.keys('ns');
        await adapter.delete('ns', 'k');
        await settle(() => adapter.set('ns', 'k', entry('v', { sizeBytes: 11 })));
        await adapter.clear('ns');
        await adapter.clear();

        expect(events).toEqual([]);
      });

      it('closes idempotently', () => {
        const adapter = create();

        adapter.close();
        expect(() => {
          adapter.close();
        }).not.toThrow();
      });
    });

    describe('entries', () => {
      it('misses an absent key and lists no keys for an empty namespace', async () => {
        const adapter = create();

        expect(await adapter.get('ns', 'k')).toBeUndefined();
        expect(await adapter.keys('ns')).toEqual([]);
      });

      it('reads back every field it stored, and no others', async () => {
        const adapter = create();
        const full = entry(
          { id: 't1', seats: [1, 2], price: 9.5, paid: true, note: null, name: 'Zoë 🎫' },
          { schemaVersion: 3, freshUntil: start + 1_000, expiresAt: start + 5_000, sizeBytes: 120 },
        );
        const bare = entry('plain');

        await adapter.set('ns', 'full', full);
        await adapter.set('ns', 'bare', bare);

        expect(await adapter.get('ns', 'full')).toStrictEqual(full);
        expect(await adapter.get('ns', 'bare')).toStrictEqual(bare);
      });

      it('replaces the previous envelope of a key', async () => {
        const adapter = create();

        await adapter.set('ns', 'k', entry('old'));
        await adapter.set('ns', 'k', entry('new', { schemaVersion: 2 }));

        expect(await adapter.get('ns', 'k')).toStrictEqual(entry('new', { schemaVersion: 2 }));
        expect(await adapter.keys('ns')).toEqual(['k']);
      });

      it('deletes a key, and deleting a missing key succeeds', async () => {
        const adapter = create();
        await adapter.set('ns', 'k', entry('v'));

        await adapter.delete('ns', 'k');
        await adapter.delete('ns', 'k');
        await adapter.delete('other', 'k');

        expect(await adapter.get('ns', 'k')).toBeUndefined();
        expect(await adapter.keys('ns')).toEqual([]);
      });

      it('accepts any string as a key', async () => {
        const adapter = create();
        const keys = [
          '',
          ' ',
          'a:b:c',
          'x\u0000y',
          'pwa-cache-kit:other:ns:k',
          '🎫',
          'k'.repeat(500),
        ];

        for (const key of keys) await adapter.set('ns', key, entry(key));

        expect(await sortedKeys(adapter, 'ns')).toEqual([...keys].sort());
        for (const key of keys) expect(await adapter.get('ns', key)).toStrictEqual(entry(key));
        for (const key of keys) await adapter.delete('ns', key);
        expect(await adapter.keys('ns')).toEqual([]);
      });

      it('keeps namespaces apart, including one whose name starts with another', async () => {
        const adapter = create();
        await adapter.set('a', 'k', entry('in a'));
        await adapter.set('ab', 'k', entry('in ab'));
        await adapter.set('ab', 'only-ab', entry('in ab'));

        expect(await adapter.get('a', 'k')).toStrictEqual(entry('in a'));
        expect(await adapter.keys('a')).toEqual(['k']);

        await adapter.delete('a', 'k');
        expect(await adapter.get('ab', 'k')).toStrictEqual(entry('in ab'));

        await adapter.set('a', 'k', entry('in a'));
        await adapter.clear('a');
        expect(await adapter.keys('a')).toEqual([]);
        expect(await sortedKeys(adapter, 'ab')).toEqual(['k', 'only-ab']);
      });

      it('clears one namespace, or every namespace of the cache', async () => {
        const adapter = create();
        await adapter.set('one', 'k', entry('v'));
        await adapter.set('two', 'k', entry('v'));
        await adapter.set('three', 'k', entry('v'));

        await adapter.clear('one');
        expect(await adapter.keys('one')).toEqual([]);
        expect(await adapter.keys('two')).toEqual(['k']);

        await adapter.clear();
        expect(await adapter.keys('two')).toEqual([]);
        expect(await adapter.keys('three')).toEqual([]);
      });

      it('keeps caches apart, including one whose name starts with another', async () => {
        const name = `cache${String(++cacheCount)}`;
        const first = create(undefined, name);
        const second = create(undefined, `${name}-2`);
        await first.set('ns', 'k', entry('first'));
        await second.set('ns', 'k', entry('second'));

        await first.delete('ns', 'k');
        expect(await second.get('ns', 'k')).toStrictEqual(entry('second'));

        await first.set('ns', 'k', entry('first'));
        await first.clear('ns');
        await first.set('other', 'k', entry('first'));
        await first.clear();
        expect(await first.keys('other')).toEqual([]);
        expect(await second.get('ns', 'k')).toStrictEqual(entry('second'));
      });
    });

    describe('expiry', () => {
      it('returns expired entries and lists their keys, leaving expiry to the orchestrator', async () => {
        const adapter = create();
        const expiring = entry('v', { freshUntil: start + 10, expiresAt: start + 20 });
        await adapter.set('ns', 'k', expiring);

        vi.advanceTimersByTime(1_000);

        expect(await adapter.get('ns', 'k')).toStrictEqual(expiring);
        expect(await adapter.keys('ns')).toEqual(['k']);
        expect(events).toEqual([]);
      });

      it('sweeps expired entries only, if the tier sweeps', async ({ skip }) => {
        const adapter = create();
        if (!adapter.sweep) {
          skip('the tier does not sweep');
          return;
        }
        await adapter.set('ns', 'expired', entry('v', { expiresAt: start + 10 }));
        await adapter.set('ns', 'expires-now', entry('v', { expiresAt: start + 100 }));
        await adapter.set(
          'ns',
          'stale',
          entry('v', { freshUntil: start + 10, expiresAt: start + 101 }),
        );
        await adapter.set('ns', 'forever', entry('v'));

        vi.setSystemTime(start + 100);
        await adapter.sweep();

        expect(await sortedKeys(adapter, 'ns')).toEqual(['forever', 'stale']);
        expect(events).toHaveLength(2);
        expect(events).toEqual(
          expect.arrayContaining([
            { type: 'expire', namespace: 'ns', key: 'expired', tier: adapter.name },
            { type: 'expire', namespace: 'ns', key: 'expires-now', tier: adapter.name },
          ]),
        );
      });
    });

    describe('budgets', () => {
      it.each([
        { maxBytes: 0 },
        { maxBytes: -1 },
        { maxBytes: Number.NaN },
        { maxBytes: Infinity },
        { maxEntryBytes: 0 },
        { maxBytes: 100, maxEntryBytes: 101 },
      ])('rejects budget options %o with a TypeError', (options) => {
        expect(() => harness.tier(options)).toThrow(TypeError);
      });

      it('refuses an entry above maxEntryBytes with ENTRY_TOO_LARGE and changes nothing', async () => {
        const adapter = create({ maxBytes: 100, maxEntryBytes: 50 });
        await adapter.set('ns', 'kept', entry('kept', { sizeBytes: 30 }));

        const error = await failure(() =>
          adapter.set('ns', 'big', entry('big', { sizeBytes: 51 })),
        );
        expectCacheError(error, 'ENTRY_TOO_LARGE', adapter, 'ns', 'big');

        const replacement = await failure(() =>
          adapter.set('ns', 'kept', entry('new', { sizeBytes: 51 })),
        );
        expectCacheError(replacement, 'ENTRY_TOO_LARGE', adapter, 'ns', 'kept');

        expect(await adapter.get('ns', 'kept')).toStrictEqual(entry('kept', { sizeBytes: 30 }));
        expect(await adapter.get('ns', 'big')).toBeUndefined();
        await adapter.set('ns', 'limit', entry('limit', { sizeBytes: 50 }));
        expect(await sortedKeys(adapter, 'ns')).toEqual(['kept', 'limit']);
      });

      it('defaults maxEntryBytes to a quarter of maxBytes', async () => {
        const adapter = create({ maxBytes: 100 });

        await adapter.set('ns', 'quarter', entry('v', { sizeBytes: 25 }));
        const error = await failure(() => adapter.set('ns', 'more', entry('v', { sizeBytes: 26 })));

        expectCacheError(error, 'ENTRY_TOO_LARGE', adapter, 'ns', 'more');
      });

      it('evicts the least recently written entries when over maxBytes', async () => {
        const adapter = create({ maxBytes: 100, maxEntryBytes: 50 });
        await fill(adapter, 'ns', { a: 30, b: 30, c: 30, d: 30 });
        await settleBudget(adapter);

        expect(await sortedKeys(adapter, 'ns')).toEqual(['b', 'c', 'd']);
        expect(events).toEqual([evicted(adapter, 'ns', 'a', 30, 'budget')]);
      });

      it('evicts expired entries before live ones', async () => {
        const adapter = create({ maxBytes: 100, maxEntryBytes: 50 });
        await fill(adapter, 'ns', { a: 30 });
        await adapter.set('ns', 'b', entry('v', { sizeBytes: 30, expiresAt: start + 50 }));
        await fill(adapter, 'ns', { c: 30 });

        vi.setSystemTime(start + 50);
        await fill(adapter, 'ns', { d: 30 });
        await settleBudget(adapter);

        expect(await sortedKeys(adapter, 'ns')).toEqual(['a', 'c', 'd']);
        expect(events).toEqual([{ type: 'expire', namespace: 'ns', key: 'b', tier: adapter.name }]);
      });

      it('counts a replaced entry once and evicts only above maxBytes', async () => {
        const adapter = create({ maxBytes: 100, maxEntryBytes: 50 });
        await fill(adapter, 'ns', { a: 30 });
        await fill(adapter, 'ns', { a: 40, b: 30, c: 30 });
        await settleBudget(adapter);

        expect(events).toEqual([]);

        await fill(adapter, 'ns', { d: 1 });
        await settleBudget(adapter);

        expect(await sortedKeys(adapter, 'ns')).toEqual(['b', 'c', 'd']);
        expect(events).toEqual([evicted(adapter, 'ns', 'a', 40, 'budget')]);
      });

      it('never evicts the entry being written, if the tier evicts in set', async ({ skip }) => {
        const adapter = create({ maxBytes: 100, maxEntryBytes: 100 });
        if (!adapter.sync) {
          skip('async tiers evict in sweep, where no entry is being written');
          return;
        }
        await fill(adapter, 'ns', { newer: 60 });

        // Recency alone would pick this entry: its updatedAt is older than the stored one's.
        await adapter.set('ns', 'older', entry('v', { sizeBytes: 100, updatedAt: start - 1_000 }));

        expect(await adapter.keys('ns')).toEqual(['older']);
        expect(events).toEqual([evicted(adapter, 'ns', 'newer', 60, 'budget')]);
      });

      it('shares one budget across the namespaces of a cache', async () => {
        const adapter = create({ maxBytes: 100, maxEntryBytes: 50 });
        await fill(adapter, 'one', { a: 30 });
        await fill(adapter, 'two', { b: 30 });
        await fill(adapter, 'one', { c: 30 });
        await fill(adapter, 'two', { d: 30 });
        await settleBudget(adapter);

        expect(await adapter.keys('one')).toEqual(['c']);
        expect(events).toEqual([evicted(adapter, 'one', 'a', 30, 'budget')]);
      });

      it('keeps a separate budget per cache', async () => {
        const options = { maxBytes: 100, maxEntryBytes: 50 };
        const first = create(options);
        const second = create(options);
        await fill(first, 'ns', { a: 30, b: 30, c: 30 });
        await fill(second, 'ns', { a: 30, b: 30, c: 30 });
        await settleBudget(first);
        await settleBudget(second);

        expect(await sortedKeys(first, 'ns')).toEqual(['a', 'b', 'c']);
        expect(await sortedKeys(second, 'ns')).toEqual(['a', 'b', 'c']);
        expect(events).toEqual([]);
      });
    });

    describe.skipIf(!harness.failWrites)('quota errors', () => {
      const failWrites = (count: number) => {
        harness.failWrites?.(count);
      };

      it('makes room, expired entries first, and retries once', async () => {
        const adapter = create();
        await fill(adapter, 'ns', { a: 30 });
        await adapter.set('ns', 'b', entry('v', { sizeBytes: 30, expiresAt: start + 50 }));
        await fill(adapter, 'ns', { c: 30 });
        vi.setSystemTime(start + 50);

        failWrites(1);
        await adapter.set('ns', 'd', entry('d', { sizeBytes: 50 }));

        expect(await adapter.get('ns', 'd')).toStrictEqual(entry('d', { sizeBytes: 50 }));
        expect(await sortedKeys(adapter, 'ns')).toEqual(['c', 'd']);
        expect(events).toEqual([
          { type: 'expire', namespace: 'ns', key: 'b', tier: adapter.name },
          evicted(adapter, 'ns', 'a', 30, 'quota'),
        ]);
      });

      it('fails with QUOTA_EXCEEDED when the retry fails too', async () => {
        const adapter = create();
        await fill(adapter, 'ns', { a: 30 });

        failWrites(2);
        const error = await failure(() => adapter.set('ns', 'b', entry('b', { sizeBytes: 30 })));

        expectCacheError(error, 'QUOTA_EXCEEDED', adapter, 'ns', 'b');
        expect((error as CacheError).cause).toBeDefined();
        expect(await adapter.get('ns', 'b')).toBeUndefined();
        await adapter.set('ns', 'b', entry('b', { sizeBytes: 30 }));
        expect(await adapter.keys('ns')).toEqual(['b']);
      });
    });

    describe.skipIf(!harness.writeRaw)('records it cannot read', () => {
      async function writeRaw(adapter: TierAdapter, cacheName: string, kind: 'corrupt' | 'newer') {
        await adapter.keys('ns');
        await harness.writeRaw?.(cacheName, 'ns', 'k', kind);
      }

      it('removes a corrupt record, then fails with CORRUPT_ENTRY', async () => {
        const cacheName = `cache${String(++cacheCount)}`;
        const adapter = create(undefined, cacheName);
        await writeRaw(adapter, cacheName, 'corrupt');

        const error = await failure(() => adapter.get('ns', 'k'));

        expectCacheError(error, 'CORRUPT_ENTRY', adapter, 'ns', 'k');
        expect(await adapter.get('ns', 'k')).toBeUndefined();
        expect(await adapter.keys('ns')).toEqual([]);
        expect(events).toEqual([]);
      });

      it('leaves a record of a later format in place', async () => {
        const cacheName = `cache${String(++cacheCount)}`;
        const adapter = create(undefined, cacheName);
        await writeRaw(adapter, cacheName, 'newer');

        expect(await adapter.get('ns', 'k')).toBe('newer');
        expect(await adapter.get('ns', 'k')).toBe('newer');
        expect(await adapter.keys('ns')).toEqual(['k']);
      });
    });
  });
}

/** A format-1 envelope written now, with a size of 10 unless overridden. */
function entry(value: CacheValue, overrides: Partial<Omit<Envelope, 'format'>> = {}): Envelope {
  return { format: 1, value, schemaVersion: 1, updatedAt: Date.now(), sizeBytes: 10, ...overrides };
}

function evicted(
  adapter: TierAdapter,
  namespace: string,
  key: string,
  sizeBytes: number,
  reason: 'budget' | 'quota',
): TierEvent {
  return { type: 'evict', namespace, key, tier: adapter.name, sizeBytes, reason };
}

function expectCacheError(
  error: unknown,
  code: CacheErrorCode,
  adapter: TierAdapter,
  namespace: string,
  key: string,
): void {
  expect(error).toBeInstanceOf(CacheError);
  expect(error).toMatchObject({ code, tier: adapter.name, namespace, key });
}

/** The error a sync call throws or an async call rejects with; fails the test if it succeeds. */
async function failure(call: () => unknown): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to fail');
}

/** Runs a call that may throw or reject, and ignores the failure. */
async function settle(call: () => unknown): Promise<void> {
  try {
    await call();
  } catch {
    // Expected.
  }
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
