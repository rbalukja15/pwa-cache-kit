// Smoke tests of the IndexedDB tier in real browsers (#11): fake-indexeddb hides engine quirks.
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

type Library = typeof import('../src/index.js');

const ORIGIN = 'http://localhost:4173';
const dist = new URL('../dist/', import.meta.url);

test.beforeEach(async ({ page }) => {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith('/dist/')) {
      const body = await readFile(new URL(pathname.slice('/dist/'.length), dist));
      await route.fulfill({ body, contentType: 'text/javascript' });
    } else {
      await route.fulfill({
        body: '<!doctype html><title>smoke</title>',
        contentType: 'text/html',
      });
    }
  });
  await page.goto(`${ORIGIN}/`);
});

test('stores structured values and serves them to a new cache instance', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const url = '/dist/index.js';
    const { createCache, indexedDBTier, memoryTier } = (await import(url)) as Library;
    const tiers = () => [memoryTier(), indexedDBTier()];
    const options = { tiers: ['memory', 'indexeddb'] } as const;

    const first = createCache({ name: 'smoke', tiers: tiers() });
    const pending = first.status().indexeddb;
    const value = { when: new Date(0), tags: new Map([['a', 1]]), bytes: new Uint8Array([1, 2]) };
    const stored = await first.namespace('n', options).set('k', value);
    first.close();

    const second = createCache({ name: 'smoke', tiers: tiers() });
    const promoted: string[] = [];
    second.on('promote', (event) => promoted.push(`${event.from} -> ${event.tier}`));
    const read = await second.namespace('n', options).get('k');
    const keys = await second.namespace('n', { tiers: ['indexeddb'] }).keys();
    await second.namespace('n', options).delete('k');
    const afterDelete = await second.namespace('n', { tiers: ['indexeddb'] }).get('k');
    second.close();

    const copy = read as typeof value | undefined;
    return {
      pending,
      stored: stored.stored,
      when: copy?.when instanceof Date ? copy.when.getTime() : undefined,
      tag: copy?.tags instanceof Map ? copy.tags.get('a') : undefined,
      bytes: copy?.bytes instanceof Uint8Array ? [...copy.bytes] : undefined,
      promoted,
      keys,
      afterDelete,
    };
  });

  expect(result).toEqual({
    pending: 'pending',
    stored: ['memory', 'indexeddb'],
    when: 0,
    tag: 1,
    bytes: [1, 2],
    promoted: ['indexeddb -> memory'],
    keys: ['k'],
  });
});

test('sweeps expired entries when a cache is created', async ({ page }) => {
  const expired = await page.evaluate(async () => {
    const url = '/dist/index.js';
    const { createCache, indexedDBTier } = (await import(url)) as Library;
    const first = createCache({ name: 'sweep', tiers: [indexedDBTier()] });
    await first.namespace('n', { tiers: ['indexeddb'], ttlMs: 1 }).set('k', 'v');
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = createCache({ name: 'sweep', tiers: [indexedDBTier()] });
    // Resolves [] if no expire event arrives, so a failure shows the keys instead of a timeout.
    const keys = await Promise.race([
      new Promise<string[]>((resolve) => {
        second.on('expire', (event) => {
          resolve([event.key]);
        });
      }),
      new Promise<string[]>((resolve) => {
        setTimeout(() => {
          resolve([]);
        }, 5_000);
      }),
    ]);
    second.close();
    return keys;
  });

  expect(expired).toEqual(['k']);
});

test('lets another context delete the database, then reopens it', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const url = '/dist/index.js';
    const { createCache, indexedDBTier } = (await import(url)) as Library;
    const cache = createCache({ name: 'versions', tiers: [indexedDBTier()], sweepIntervalMs: 0 });
    const ns = cache.namespace('n', { tiers: ['indexeddb'] });
    await ns.set('k', 'before');

    const deleted = await new Promise<string>((resolve) => {
      const request = indexedDB.deleteDatabase('pwa-cache-kit:versions');
      request.onsuccess = () => {
        resolve('deleted');
      };
      request.onblocked = () => {
        resolve('blocked');
      };
    });
    const afterDeletion = await ns.get('k');
    const stored = await ns.set('k', 'after');
    const read = await ns.get('k');
    const status = cache.status().indexeddb;
    cache.close();
    return { deleted, afterDeletion, stored: stored.stored, read, status };
  });

  expect(result).toEqual({
    deleted: 'deleted',
    stored: ['indexeddb'],
    read: 'after',
    status: 'available',
  });
});

test('turns unavailable once when a later version holds the database', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const url = '/dist/index.js';
    const { createCache, indexedDBTier } = (await import(url)) as Library;
    await new Promise<void>((resolve) => {
      const request = indexedDB.open('pwa-cache-kit:later', 2);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });

    const cache = createCache({ name: 'later', tiers: [indexedDBTier()], sweepIntervalMs: 0 });
    const codes: string[] = [];
    cache.on('error', (event) => codes.push(event.error.code));
    const ns = cache.namespace('n', { tiers: ['indexeddb'] });
    const read = await ns.get('k');
    const write = await ns.set('k', 'v').then(
      (outcome) => outcome.stored,
      (error: unknown) => (error as Error).name,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const status = cache.status().indexeddb;
    cache.close();
    return { read, write, codes, status };
  });

  expect(result).toEqual({ write: [], codes: ['TIER_UNAVAILABLE'], status: 'unavailable' });
});
