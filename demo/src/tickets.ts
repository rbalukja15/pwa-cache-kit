// The wallet's data: tickets fetched from a static JSON "API" and kept in the cache.
import { createCache, indexedDBTier, memoryTier, sessionTier } from '@rbalukja/pwa-cache-kit';

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

/** All three tiers: memory for this page, session for reloads in this tab, IndexedDB for later. */
export const cache = createCache({
  name: 'ticket-wallet',
  tiers: [memoryTier(), sessionTier(), indexedDBTier()],
});

/**
 * Offline-first: a list younger than five minutes is served without a request; an older one is
 * served at once and refreshed in the background, and kept for as long as the network is away.
 */
export const wallet = cache.namespace<Ticket[]>('wallet', {
  tiers: ['memory', 'session', 'indexeddb'],
  ttlMs: 5 * 60_000,
  staleWhileRevalidateMs: Infinity,
});

export const TICKETS_KEY = 'tickets';

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
