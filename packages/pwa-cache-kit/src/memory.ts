// The memory tier's adapter (ADR-0002 sections 6, 7, 14 and 17). Not exported from index.ts: the
// public `memoryTier` factory wraps it once #7 gives tier configs their internal `create`.
import { CacheError } from './errors.js';
import { tierBudget, type CreateTierAdapter, type Envelope, type TierAdapter } from './tier.js';
import type { TierOptions } from './types.js';

/** Separates the namespace from the key; names cannot contain it, keys may. */
const SEPARATOR = '\u0000';

/**
 * Builds memory adapters with one budget. Each adapter keeps its cache's entries in one `Map`, in
 * least recently used order: `get` and `set` move an entry to the end, and eviction starts at the
 * front. The adapter cannot tell a hit from a stale read (it may not act on expiry in `get`), so
 * every read that returns an entry refreshes it.
 * @throws {TypeError} for invalid budget options (see `tierBudget`).
 */
export function memoryAdapter(options?: TierOptions): CreateTierAdapter<true> {
  const { maxBytes, maxEntryBytes } = tierBudget('memory', options);

  return (_cacheName, emit) => {
    const entries = new Map<string, Envelope>();
    let usage = 0;

    function remove(id: string, envelope: Envelope): void {
      entries.delete(id);
      usage -= envelope.sizeBytes;
    }

    /** Removes entries in Map order, expired ones first, down to `maxBytes`, sparing `spare`. */
    function evict(spare: string): void {
      const now = Date.now();
      for (const expiredPass of [true, false]) {
        for (const [id, envelope] of entries) {
          if (usage <= maxBytes) return;
          const expired = envelope.expiresAt !== undefined && envelope.expiresAt <= now;
          if (id === spare || expired !== expiredPass) continue;
          remove(id, envelope);
          const separator = id.indexOf(SEPARATOR);
          const namespace = id.slice(0, separator);
          const key = id.slice(separator + 1);
          if (expired) {
            if (emit.has('expire')) emit({ type: 'expire', namespace, key, tier: 'memory' });
          } else if (emit.has('evict')) {
            const { sizeBytes } = envelope;
            emit({ type: 'evict', namespace, key, tier: 'memory', sizeBytes, reason: 'budget' });
          }
        }
      }
    }

    const adapter: TierAdapter<true> = {
      name: 'memory',
      sync: true,
      status: 'available',
      get(ns, key) {
        const id = ns + SEPARATOR + key;
        const envelope = entries.get(id);
        if (envelope === undefined) return undefined;
        entries.delete(id);
        entries.set(id, envelope);
        return envelope;
      },
      set(ns, key, envelope) {
        if (envelope.sizeBytes > maxEntryBytes) {
          const sizes = `${String(envelope.sizeBytes)} > ${String(maxEntryBytes)} bytes`;
          const context = { tier: 'memory', namespace: ns, key } as const;
          throw new CacheError(
            'ENTRY_TOO_LARGE',
            `memory tier: entry too large (${sizes})`,
            context,
          );
        }
        const id = ns + SEPARATOR + key;
        const previous = entries.get(id);
        if (previous !== undefined) remove(id, previous);
        entries.set(id, envelope);
        usage += envelope.sizeBytes;
        if (usage > maxBytes) evict(id);
      },
      delete(ns, key) {
        const id = ns + SEPARATOR + key;
        const envelope = entries.get(id);
        if (envelope !== undefined) remove(id, envelope);
      },
      clear(ns) {
        if (ns === undefined) {
          entries.clear();
          usage = 0;
          return;
        }
        const prefix = ns + SEPARATOR;
        for (const [id, envelope] of entries) if (id.startsWith(prefix)) remove(id, envelope);
      },
      keys(ns) {
        const prefix = ns + SEPARATOR;
        const keys: string[] = [];
        for (const id of entries.keys()) {
          if (id.startsWith(prefix)) keys.push(id.slice(prefix.length));
        }
        return keys;
      },
      close() {
        entries.clear();
        usage = 0;
      },
    };
    return adapter;
  };
}
