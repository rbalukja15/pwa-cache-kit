// The in-page cache inspector (#16), published as `@rbalukja/pwa-cache-kit/inspector`. It reads a
// cache only through its public events (ADR-0002 section 11), so it works with any cache.
import type { CacheEvent, CacheEventType } from '../events.js';
import type { TieredCache, TierName } from '../types.js';
import {
  createModel,
  describeEvent,
  describeTtl,
  formatBytes,
  TIERS,
  type KeyRow,
  type LogEntry,
  type TierCopy,
} from './model.js';
import { STYLES } from './styles.js';

/** Options of `createInspector`. */
export interface InspectorOptions {
  /** Element the panel is appended to. Default `document.body`. */
  readonly container?: HTMLElement;
  /** How many events the log keeps. Default 200. */
  readonly maxLogEntries?: number;
  /** Start collapsed to its header. Default false. */
  readonly collapsed?: boolean;
}

/** A mounted inspector panel. */
export interface CacheInspector {
  /** Shows this cache's events from now on, instead of the previous cache's. */
  attach(cache: TieredCache): void;
  /** Stops listening to the attached cache; the panel keeps what it showed. */
  detach(): void;
  /** Detaches, stops the timer and removes the panel. */
  destroy(): void;
}

const EVENT_TYPES: readonly CacheEventType[] = [
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

const TIER_LABELS: Record<TierName, string> = {
  memory: 'memory',
  session: 'session',
  indexeddb: 'IndexedDB',
};

const TICK_MS = 1_000;

/**
 * Mounts a panel that shows, live, which tier served each read, the keys each tier holds with
 * their time to live and size, and evictions, all from the cache's events. Entries written before
 * `attach` show up once an event mentions them.
 */
export function createInspector(options: InspectorOptions = {}): CacheInspector {
  const maxLog = options.maxLogEntries ?? 200;
  if (!Number.isInteger(maxLog) || maxLog < 1) {
    throw new TypeError('createInspector: maxLogEntries must be a positive integer');
  }
  const model = createModel(maxLog);
  const host = document.createElement('pwa-cache-inspector');
  host.setAttribute('data-testid', 'cache-inspector');
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = STYLES;
  const panel = element('section', 'panel');
  panel.setAttribute('aria-label', 'Cache inspector');
  if (options.collapsed === true) panel.classList.add('collapsed');

  const header = document.createElement('header');
  const title = element('h2');
  title.textContent = 'Cache inspector';
  const status = element('span', 'status');
  status.setAttribute('data-testid', 'inspector-status');
  header.append(title, status);

  const clearLog = button('Clear log', () => {
    model.clearLog();
    log.replaceChildren();
    render();
  });
  const collapse = button(options.collapsed === true ? 'Show' : 'Hide', () => {
    const collapsed = panel.classList.toggle('collapsed');
    collapse.textContent = collapsed ? 'Show' : 'Hide';
    collapse.setAttribute('aria-expanded', String(!collapsed));
    if (!collapsed) render();
  });
  collapse.setAttribute('aria-expanded', String(options.collapsed !== true));
  header.append(clearLog, collapse);

  const body = element('div', 'body');
  const keysTitle = element('h3');
  keysTitle.textContent = 'Keys';
  const table = document.createElement('table');
  table.innerHTML =
    '<thead><tr><th scope="col">Key</th><th scope="col">Tiers</th><th scope="col">TTL</th><th scope="col">Size</th></tr></thead>';
  const rowsBody = document.createElement('tbody');
  rowsBody.setAttribute('data-testid', 'inspector-keys');
  table.append(rowsBody);
  const logTitle = element('h3');
  logTitle.textContent = 'Events (newest first)';
  const log = element('ol', 'log');
  log.setAttribute('data-testid', 'inspector-log');
  body.append(keysTitle, table, logTitle, log);

  panel.append(header, body);
  root.append(style, panel);
  (options.container ?? document.body).append(host);

  let cache: TieredCache | undefined;
  let unsubscribe: (() => void)[] = [];
  let lastLogged = 0;
  let scheduled = false;
  // Ticks TTLs and drops evicted copies; a collapsed panel draws nothing until it opens.
  const timer = setInterval(() => {
    if (model.prune(Date.now()) || model.rows().length > 0) renderVisible();
  }, TICK_MS);

  function handle(event: CacheEvent): void {
    model.apply(event, Date.now());
    if (scheduled) return;
    scheduled = true;
    // Many events arrive in one operation; draw once after it.
    queueMicrotask(() => {
      scheduled = false;
      renderVisible();
    });
  }

  function renderVisible(): void {
    if (!panel.classList.contains('collapsed')) render();
  }

  function render(): void {
    const now = Date.now();
    renderStatus();
    renderRows(model.rows(), now);
    renderLog(model.log());
  }

  function renderStatus(): void {
    const tiers = cache?.status() ?? {};
    status.replaceChildren(
      ...TIERS.filter((tier) => tiers[tier] !== undefined).map((tier) => {
        const badge = element('span', `tier ${tier}`);
        if (tiers[tier] === 'unavailable') badge.classList.add('unavailable');
        badge.textContent = TIER_LABELS[tier];
        badge.title = `${TIER_LABELS[tier]}: ${tiers[tier] ?? ''}`;
        return badge;
      }),
    );
  }

  function renderRows(rows: readonly KeyRow[], now: number): void {
    if (rows.length === 0) {
      const empty = document.createElement('tr');
      const cell = document.createElement('td');
      cell.className = 'empty';
      cell.colSpan = 4;
      cell.textContent = 'No keys seen yet. Keys show up as the app reads and writes them.';
      empty.append(cell);
      rowsBody.replaceChildren(empty);
      return;
    }
    rowsBody.replaceChildren(
      ...rows.map((row) => {
        const tr = document.createElement('tr');
        tr.setAttribute('data-key', `${row.namespace}/${row.key}`);
        const copies = TIERS.flatMap((tier) => {
          const copy = row.tiers[tier];
          return copy ? [{ tier, copy }] : [];
        });
        const live = copies.find(({ copy }) => copy.evictedAt === undefined);
        if (!live) tr.classList.add('evicted');

        const key = element('td', 'key');
        key.textContent = `${row.namespace}/${row.key}`;
        const tiers = document.createElement('td');
        tiers.append(...copies.map(({ tier, copy }) => tierBadge(tier, copy)));
        const ttl = document.createElement('td');
        ttl.textContent = live ? describeTtl(live.copy, now) : 'evicted';
        const size = document.createElement('td');
        const sized = (live ?? copies[0])?.copy.sizeBytes;
        size.textContent = sized === undefined ? '' : formatBytes(sized);
        tr.append(key, tiers, ttl, size);
        return tr;
      }),
    );
  }

  function tierBadge(tier: TierName, copy: TierCopy): HTMLElement {
    const badge = element('span', `tier ${tier}`);
    badge.textContent = TIER_LABELS[tier];
    if (copy.evictedAt !== undefined) {
      badge.classList.add('evicted');
      badge.title = `evicted (${copy.evictReason ?? 'budget'})`;
    }
    return badge;
  }

  function renderLog(entries: readonly LogEntry[]): void {
    const fresh = entries.filter((entry) => entry.id > lastLogged);
    for (const entry of fresh) log.prepend(logLine(entry));
    if (fresh.length > 0) lastLogged = fresh[fresh.length - 1]?.id ?? lastLogged;
    while (log.childElementCount > maxLog) log.lastElementChild?.remove();
  }

  function logLine({ time, event }: LogEntry): HTMLElement {
    const li = element('li', event.type);
    li.setAttribute('data-type', event.type);
    if (event.tier !== undefined) li.setAttribute('data-tier', event.tier);
    const at = document.createElement('time');
    at.dateTime = new Date(time).toISOString();
    at.textContent = new Date(time).toLocaleTimeString(undefined, { hour12: false });
    const type = element('span', `type ${event.type}`);
    type.textContent = event.type;
    const text = element('span', 'text');
    text.textContent = describeEvent(event);
    li.append(at, type, text);
    return li;
  }

  function detach(): void {
    for (const off of unsubscribe) off();
    unsubscribe = [];
  }

  render();

  return {
    attach(next) {
      detach();
      cache = next;
      // A new cache has its own entries; keep the log, drop the keys.
      model.forgetKeys();
      unsubscribe = EVENT_TYPES.map((type) => next.on(type, handle));
      render();
    },
    detach,
    destroy() {
      detach();
      clearInterval(timer);
      host.remove();
    },
  };
}

function element(tag: string, className?: string): HTMLElement {
  const created = document.createElement(tag);
  if (className !== undefined) created.className = className;
  return created;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const created = document.createElement('button');
  created.type = 'button';
  created.textContent = label;
  created.addEventListener('click', onClick);
  return created;
}
