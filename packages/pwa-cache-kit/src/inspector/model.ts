// The inspector's view of a cache, rebuilt from its events alone (ADR-0002 section 11): which
// tiers hold which keys, with size and expiry, and a bounded log of recent events.
import type { CacheEvent } from '../events.js';
import type { TierName } from '../types.js';

/** What the inspector knows about one tier's copy of a key. */
export interface TierCopy {
  readonly sizeBytes: number | undefined;
  readonly freshUntil: number | undefined;
  readonly expiresAt: number | undefined;
  /** Set when the copy was evicted; the row keeps it, highlighted, until `EVICTED_MS` passes. */
  readonly evictedAt: number | undefined;
  /** `evict` reason: budget or quota. */
  readonly evictReason: 'budget' | 'quota' | undefined;
}

/** One key of one namespace, with its copies in tier order. */
export interface KeyRow {
  readonly namespace: string;
  readonly key: string;
  readonly tiers: Readonly<Partial<Record<TierName, TierCopy>>>;
}

export interface LogEntry {
  /** Increases by one per event, so a view can append only what is new. */
  readonly id: number;
  readonly time: number;
  readonly event: CacheEvent;
}

/** How long an evicted copy stays in the table, highlighted. */
export const EVICTED_MS = 5_000;

export const TIERS: readonly TierName[] = ['memory', 'session', 'indexeddb'];

export interface InspectorModel {
  /** Applies one event at `now`. */
  apply(event: CacheEvent, now: number): void;
  /** Drops evicted copies older than `EVICTED_MS`; returns whether anything changed. */
  prune(now: number): boolean;
  /** Rows sorted by namespace, then key. */
  rows(): KeyRow[];
  /** The latest events, oldest first, at most `maxLog`. */
  log(): readonly LogEntry[];
  /** Forgets every key, when the inspector moves to another cache. */
  forgetKeys(): void;
  /** Empties the log; ids keep increasing. */
  clearLog(): void;
}

const SEPARATOR = '\u0000';

export function createModel(maxLog: number): InspectorModel {
  const rows = new Map<
    string,
    { namespace: string; key: string; tiers: Map<TierName, TierCopy> }
  >();
  let entries: LogEntry[] = [];
  let nextId = 1;

  function row(namespace: string, key: string) {
    const id = namespace + SEPARATOR + key;
    let found = rows.get(id);
    if (!found) {
      found = { namespace, key, tiers: new Map() };
      rows.set(id, found);
    }
    return found;
  }

  function store(
    namespace: string,
    key: string,
    tier: TierName,
    copy: { sizeBytes?: number; freshUntil?: number; expiresAt?: number },
  ): void {
    row(namespace, key).tiers.set(tier, {
      sizeBytes: copy.sizeBytes,
      freshUntil: copy.freshUntil,
      expiresAt: copy.expiresAt,
      evictedAt: undefined,
      evictReason: undefined,
    });
  }

  function drop(namespace: string, key: string, tier: TierName): void {
    const id = namespace + SEPARATOR + key;
    const found = rows.get(id);
    if (!found) return;
    found.tiers.delete(tier);
    if (found.tiers.size === 0) rows.delete(id);
  }

  function apply(event: CacheEvent, now: number): void {
    entries.push({ id: nextId++, time: now, event });
    if (entries.length > maxLog) entries = entries.slice(entries.length - maxLog);

    switch (event.type) {
      case 'set':
      case 'promote':
      case 'hit':
        store(event.namespace, event.key, event.tier, event);
        break;
      case 'miss':
        // Absent: the tier holds nothing. Invalid: a corrupt copy was removed, or a migration
        // failed and removed it. Other misses leave the copy in place.
        if (event.reason === 'absent' || event.reason === 'invalid') {
          drop(event.namespace, event.key, event.tier);
        }
        break;
      case 'delete':
      case 'expire':
        drop(event.namespace, event.key, event.tier);
        break;
      case 'evict': {
        const { tiers } = row(event.namespace, event.key);
        const previous = tiers.get(event.tier);
        tiers.set(event.tier, {
          sizeBytes: event.sizeBytes,
          freshUntil: previous?.freshUntil,
          expiresAt: previous?.expiresAt,
          evictedAt: now,
          evictReason: event.reason,
        });
        break;
      }
      case 'clear':
        for (const [id, found] of rows) {
          if (event.namespace !== undefined && found.namespace !== event.namespace) continue;
          found.tiers.delete(event.tier);
          if (found.tiers.size === 0) rows.delete(id);
        }
        break;
      case 'error':
        break;
    }
  }

  function prune(now: number): boolean {
    let changed = false;
    for (const found of rows.values()) {
      for (const [tier, copy] of found.tiers) {
        if (copy.evictedAt !== undefined && now - copy.evictedAt >= EVICTED_MS) {
          drop(found.namespace, found.key, tier);
          changed = true;
        }
      }
    }
    return changed;
  }

  return {
    apply,
    prune,
    rows: () =>
      [...rows.values()]
        .map(({ namespace, key, tiers }) => ({ namespace, key, tiers: Object.fromEntries(tiers) }))
        .sort((a, b) =>
          a.namespace === b.namespace
            ? a.key.localeCompare(b.key)
            : a.namespace.localeCompare(b.namespace),
        ),
    log: () => entries,
    forgetKeys() {
      rows.clear();
    },
    clearLog() {
      entries = [];
    },
  };
}

/** Time to live of a copy at `now`, as the table shows it. */
export function describeTtl(copy: TierCopy, now: number): string {
  if (copy.freshUntil === undefined) return 'fresh, no expiry';
  if (now < copy.freshUntil) return `fresh for ${formatDuration(copy.freshUntil - now)}`;
  if (copy.expiresAt === undefined) return 'stale, kept';
  if (now < copy.expiresAt) return `stale, expires in ${formatDuration(copy.expiresAt - now)}`;
  return 'expired';
}

/** 42s, 4m 05s, 2h 13m or 3d 4h. */
export function formatDuration(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ${String(minutes % 60)}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
}

/** 512 B, 1.4 KB or 2.0 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One log line's details after its type: tier, key and the event's own fields. */
export function describeEvent(event: CacheEvent): string {
  switch (event.type) {
    case 'hit':
      return `${event.namespace}/${event.key} served by ${event.tier}`;
    case 'miss':
      return `${event.namespace}/${event.key} not in ${event.tier} (${event.reason})`;
    case 'set':
      return `${event.namespace}/${event.key} stored in ${event.tier} (${event.reason}, ${formatBytes(event.sizeBytes)})`;
    case 'promote':
      return `${event.namespace}/${event.key} copied from ${event.from} to ${event.tier}`;
    case 'delete':
      return `${event.namespace}/${event.key} deleted from ${event.tier}${event.reason === 'remote' ? ' (other tab)' : ''}`;
    case 'expire':
      return `${event.namespace}/${event.key} expired in ${event.tier}`;
    case 'evict':
      return `${event.namespace}/${event.key} evicted from ${event.tier} (${event.reason}, ${formatBytes(event.sizeBytes)})`;
    case 'clear':
      return `${event.namespace ?? 'every namespace'} cleared in ${event.tier}${event.reason === 'remote' ? ' (other tab)' : ''}`;
    case 'error': {
      const where = [event.tier, event.namespace, event.key].filter(Boolean).join(' ');
      return `${event.error.code}${where ? ` in ${where}` : ''}: ${event.error.message}`;
    }
  }
}
