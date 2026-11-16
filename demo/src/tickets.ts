// The wallet's data: tickets fetched from a static JSON "API" and kept in the cache.
import {
  createCache,
  indexedDBTier,
  memoryTier,
  sessionTier,
  type CacheNamespace,
  type TieredCache,
  type TierOptions,
} from '@rbalukja/pwa-cache-kit';

export interface Ticket {
  readonly id: string;
  readonly event: string;
  readonly venue: string;
  /** ISO 8601 start time. */
  readonly startsAt: string;
  readonly section: string;
  readonly seat: string;
  /** What the gate scans. */
  readonly code: string;
}

const FIELDS = ['id', 'event', 'venue', 'startsAt', 'section', 'seat', 'code'] as const;

function isTicket(value: unknown): value is Ticket {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return FIELDS.every((field) => typeof record[field] === 'string');
}

export interface Wallet {
  readonly cache: TieredCache;
  /** The ticket list, under `LIST_KEY`. */
  readonly list: CacheNamespace<Ticket[]>;
  /** Each ticket under its id, so opening one is a read of its own. */
  readonly tickets: CacheNamespace<Ticket>;
}

export const LIST_KEY = 'tickets';

/**
 * Budgets for "Simulate storage pressure": room for the list (about 2.8 KB) and a few tickets
 * (about 0.4 KB each) per tier, so caching all tickets evicts. `maxEntryBytes` stays above the
 * list's size, so writes evict instead of failing with ENTRY_TOO_LARGE.
 */
const PRESSURE: TierOptions = { maxBytes: 4_096, maxEntryBytes: 4_096 };
/** IndexedDB evicts only in its sweep, so pressure sweeps often to make that visible. */
const PRESSURE_SWEEP_MS = 2_000;

/**
 * Opens the wallet's cache: memory for this page, session for reloads in this tab, IndexedDB for
 * later. Under pressure the same cache gets small budgets and a frequent sweep.
 */
export function openWallet(pressure: boolean): Wallet {
  const budget = pressure ? PRESSURE : {};
  const cache = createCache({
    name: 'ticket-wallet',
    tiers: [memoryTier(budget), sessionTier(budget), indexedDBTier(budget)],
    ...(pressure ? { sweepIntervalMs: PRESSURE_SWEEP_MS } : {}),
  });
  // Offline-first: a copy younger than five minutes is served without a request; an older one is
  // served at once and refreshed in the background, and kept for as long as the network is away.
  const expiry = { ttlMs: 5 * 60_000, staleWhileRevalidateMs: Infinity };
  const tiers = ['memory', 'session', 'indexeddb'] as const;
  return {
    cache,
    list: cache.namespace<Ticket[]>('wallet', { tiers, ...expiry }),
    tickets: cache.namespace<Ticket>('ticket', { tiers, ...expiry }),
  };
}

/** Fetches the ticket list from the network. Rejects offline or on a bad response. */
export async function fetchTickets(): Promise<Ticket[]> {
  const response = await fetch(new URL('api/tickets.json', document.baseURI), {
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`tickets request failed: HTTP ${String(response.status)}`);
  const body: unknown = await response.json();
  if (!Array.isArray(body) || !body.every(isTicket)) throw new Error('unexpected tickets payload');
  return body;
}
