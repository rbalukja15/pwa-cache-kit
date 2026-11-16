// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCache, memoryTier, type TieredCache } from '../../src/index.js';
import { createInspector, type CacheInspector } from '../../src/inspector/index.js';
import { EVICTED_MS } from '../../src/inspector/model.js';

let inspector: CacheInspector | undefined;

function panel(): ShadowRoot {
  const host = document.querySelector('[data-testid="cache-inspector"]');
  if (!host?.shadowRoot) throw new Error('inspector not mounted');
  return host.shadowRoot;
}

function logTypes(): string[] {
  return [...panel().querySelectorAll('[data-testid="inspector-log"] li')].map(
    (li) => `${li.getAttribute('data-type') ?? ''}:${li.getAttribute('data-tier') ?? ''}`,
  );
}

function keyRows(): string[] {
  return [...panel().querySelectorAll('[data-testid="inspector-keys"] tr')].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent).join(' | '),
  );
}

/** Lets the batched render run. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function memoryCache(maxBytes?: number): TieredCache {
  return createCache({
    name: 'app',
    tiers: [memoryTier(maxBytes === undefined ? {} : { maxBytes, maxEntryBytes: maxBytes })],
  });
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  inspector?.destroy();
  inspector = undefined;
  vi.useRealTimers();
});

describe('createInspector', () => {
  it('mounts an empty panel in the body, with the tiers of the attached cache', () => {
    inspector = createInspector();
    expect(document.body.querySelector('pwa-cache-inspector')).not.toBeNull();
    expect(keyRows()).toEqual(['No keys seen yet. Keys show up as the app reads and writes them.']);
    inspector.attach(memoryCache());
    expect(panel().querySelector('[data-testid="inspector-status"]')?.textContent).toBe('memory');
  });

  it('mounts in a given container and rejects an invalid log size', () => {
    const container = document.createElement('div');
    document.body.append(container);
    inspector = createInspector({ container });
    expect(container.querySelector('pwa-cache-inspector')).not.toBeNull();
    expect(() => createInspector({ maxLogEntries: 0 })).toThrow(TypeError);
  });

  it('logs each read with the tier that served it, newest first, and lists the key', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    inspector = createInspector();
    const cache = memoryCache();
    inspector.attach(cache);
    const ns = cache.namespace('tickets', { tiers: ['memory'], ttlMs: 90_000 });

    await ns.get('t1');
    await ns.set('t1', 'seat 12A');
    await ns.get('t1');
    await settle();

    expect(logTypes()).toEqual(['hit:memory', 'set:memory', 'miss:memory']);
    expect(panel().querySelector('[data-type="hit"]')?.textContent).toContain(
      'tickets/t1 served by memory',
    );
    expect(keyRows()).toEqual(['tickets/t1 | memory | fresh for 1m 30s | 16 B']);
  });

  it('highlights evictions, then drops the evicted copy on a later tick', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(0);
    inspector = createInspector();
    const cache = memoryCache(30);
    inspector.attach(cache);
    const ns = cache.namespace('n', { tiers: ['memory'] });

    await ns.set('a', 'x'.repeat(10));
    await ns.set('b', 'y'.repeat(10));
    await settle();

    expect(logTypes()).toContain('evict:memory');
    expect(panel().querySelector('li.evict')?.textContent).toContain('n/a evicted from memory');
    const evicted = panel().querySelector('tr.evicted');
    expect(evicted?.getAttribute('data-key')).toBe('n/a');
    expect(evicted?.querySelector('.tier.evicted')?.getAttribute('title')).toBe('evicted (budget)');
    expect(keyRows()).toContain('n/a | memory | evicted | 20 B');

    vi.setSystemTime(EVICTED_MS);
    vi.advanceTimersByTime(1_000);
    expect(keyRows()).toEqual(['n/b | memory | fresh, no expiry | 20 B']);
  });

  it('keeps at most maxLogEntries lines and clears the log on request', async () => {
    inspector = createInspector({ maxLogEntries: 2 });
    const cache = memoryCache();
    inspector.attach(cache);
    const ns = cache.namespace('n', { tiers: ['memory'] });
    for (const key of ['a', 'b', 'c']) await ns.get(key);
    await settle();
    expect(logTypes()).toHaveLength(2);

    const clear = [...panel().querySelectorAll('button')].find(
      (button) => button.textContent === 'Clear log',
    );
    clear?.click();
    expect(logTypes()).toEqual([]);
    await ns.get('d');
    await settle();
    expect(logTypes()).toEqual(['miss:memory']);
  });

  it('collapses and expands', () => {
    inspector = createInspector({ collapsed: true });
    const section = panel().querySelector('section');
    const toggle = [...panel().querySelectorAll('button')].find((b) => b.textContent === 'Show');
    expect(section?.classList.contains('collapsed')).toBe(true);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    toggle?.click();
    expect(section?.classList.contains('collapsed')).toBe(false);
    expect(toggle?.textContent).toBe('Hide');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  });

  it('reports the pressure switch and moves to a new cache, keeping the log', async () => {
    const onPressureChange = vi.fn();
    inspector = createInspector({ onPressureChange, pressure: true });
    const first = memoryCache();
    inspector.attach(first);
    await first.namespace('n', { tiers: ['memory'] }).set('k', 1);
    await settle();

    const box = panel().querySelector<HTMLInputElement>('[data-testid="inspector-pressure"]');
    expect(box?.checked).toBe(true);
    if (box) {
      box.checked = false;
      box.dispatchEvent(new Event('change'));
    }
    expect(onPressureChange).toHaveBeenCalledWith(false);

    const second = memoryCache();
    inspector.attach(second);
    expect(keyRows()).toHaveLength(1);
    expect(keyRows()[0]).toContain('No keys seen yet');
    await first.namespace('n', { tiers: ['memory'] }).get('k');
    await second.namespace('n', { tiers: ['memory'] }).get('k');
    await settle();
    expect(logTypes()).toEqual(['miss:memory', 'set:memory']);
  });

  it('shows no pressure switch without a handler, and marks unavailable tiers', () => {
    inspector = createInspector();
    expect(panel().querySelector('[data-testid="inspector-pressure"]')).toBeNull();
    const cache = memoryCache();
    vi.spyOn(cache, 'status').mockReturnValue({ memory: 'unavailable' });
    inspector.attach(cache);
    expect(panel().querySelector('.status .tier')?.classList.contains('unavailable')).toBe(true);
  });

  it('stops listening on detach and removes the panel on destroy', async () => {
    inspector = createInspector();
    const cache = memoryCache();
    inspector.attach(cache);
    inspector.detach();
    await cache.namespace('n', { tiers: ['memory'] }).get('k');
    await settle();
    expect(logTypes()).toEqual([]);

    inspector.destroy();
    inspector = undefined;
    expect(document.querySelector('pwa-cache-inspector')).toBeNull();
  });
});
