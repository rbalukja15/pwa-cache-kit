import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  CacheEntry,
  CacheError,
  CacheEvent,
  CacheEventType,
  CacheNamespace,
  CacheOptions,
  CacheValue,
  SetResult,
  TierConfig,
  TierFactory,
  TierName,
  TieredCache,
} from '../src/index.js';

interface Ticket {
  id: string;
  seat: number;
}

/** The payload of one event type, and the fields every per-key event has. */
type EventOf<T extends CacheEventType> = Extract<CacheEvent, { type: T }>;
interface KeyFields<T extends CacheEventType> {
  readonly type: T;
  readonly namespace: string;
  readonly key: string;
  readonly tier: TierName;
}

// The cache has no implementation until #7, so these scenarios are only type-checked
// (by `npm run typecheck`), never called.
function namespaceScenario(cache: TieredCache, ticket: Ticket): void {
  const tickets = cache.namespace<Ticket>('tickets', { tiers: ['memory', 'indexeddb'] });

  expectTypeOf(tickets).toEqualTypeOf<CacheNamespace<Ticket>>();
  expectTypeOf(tickets.get('t1')).resolves.toEqualTypeOf<Ticket | undefined>();
  expectTypeOf(tickets.getSync('t1')).toEqualTypeOf<Ticket | undefined>();
  expectTypeOf(
    tickets.getOrSet('t1', () => Promise.resolve(ticket)),
  ).resolves.toEqualTypeOf<Ticket>();
  expectTypeOf(tickets.set('t1', ticket, { ttlMs: 60_000 })).resolves.toEqualTypeOf<SetResult>();
  expectTypeOf(cache.namespace('any', { tiers: ['memory'] })).toEqualTypeOf<
    CacheNamespace<CacheValue>
  >();

  // @ts-expect-error: the value must match the namespace's value type
  void tickets.set('t1', { id: 't1' });
  // @ts-expect-error: undefined is never a value; it means a miss
  void cache.namespace('any', { tiers: ['memory'] }).set('k', undefined);
  // @ts-expect-error: a namespace's value type cannot include undefined
  cache.namespace<string | undefined>('maybe', { tiers: ['memory'] });
  // @ts-expect-error: 'localstorage' is not a tier name
  cache.namespace('bad', { tiers: ['memory', 'localstorage'] });
}

function tierScenario(memoryTier: TierFactory<'memory'>): CacheOptions {
  expectTypeOf(memoryTier({ maxBytes: 1024 })).toEqualTypeOf<TierConfig<'memory'>>();
  // @ts-expect-error: only a tier factory creates a tier description
  const forged: TierConfig = { name: 'memory' };
  return { name: 'app', tiers: [memoryTier(), forged] };
}

function eventScenario(cache: TieredCache): void {
  cache.on('promote', (event) => {
    expectTypeOf(event.from).toEqualTypeOf<TierName>();
  });
  // @ts-expect-error: 'read' is not an event type
  cache.on('read', () => undefined);
}

function describeEvent(event: CacheEvent): string {
  switch (event.type) {
    case 'promote':
      expectTypeOf(event.sizeBytes).toEqualTypeOf<number>();
      return `${event.key}: ${event.from} -> ${event.tier}`;
    case 'miss':
      expectTypeOf(event.reason).toEqualTypeOf<
        'absent' | 'stale' | 'expired' | 'newer' | 'invalid' | 'error'
      >();
      return `${event.key}: ${event.reason}`;
    case 'clear':
      return event.namespace ?? 'all namespaces';
    case 'error':
      expectTypeOf(event.error).toEqualTypeOf<CacheError>();
      return event.error.code;
    default:
      return event.type;
  }
}

describe('public types', () => {
  it('infer value types from the namespace and narrow events in handlers', () => {
    expectTypeOf(namespaceScenario).toBeFunction();
    expectTypeOf(eventScenario).toBeFunction();
  });

  it('accept only tier factory results as tiers', () => {
    expectTypeOf(tierScenario).returns.toEqualTypeOf<CacheOptions>();
  });

  it('describe an entry read view', () => {
    expectTypeOf<CacheEntry<Ticket>>().toEqualTypeOf<{
      readonly value: Ticket;
      readonly updatedAt: number;
      readonly freshUntil?: number;
      readonly expiresAt?: number;
      readonly stale: boolean;
      readonly tier: TierName;
    }>();
  });

  it('describe set results with read-only arrays', () => {
    expectTypeOf<SetResult>().toEqualTypeOf<{
      readonly stored: readonly TierName[];
      readonly errors: readonly CacheError[];
    }>();
  });

  it('narrow CacheEvent by type', () => {
    expectTypeOf<CacheEventType>().toEqualTypeOf<
      'hit' | 'miss' | 'set' | 'promote' | 'delete' | 'expire' | 'evict' | 'clear' | 'error'
    >();
    expectTypeOf<EventOf<'set'>>().branded.toEqualTypeOf<
      KeyFields<'set'> & {
        readonly freshUntil?: number;
        readonly expiresAt?: number;
        readonly sizeBytes: number;
        readonly reason: 'set' | 'load' | 'migrate';
      }
    >();
    expectTypeOf<EventOf<'hit'>>().branded.toEqualTypeOf<
      KeyFields<'hit'> & {
        readonly freshUntil?: number;
        readonly expiresAt?: number;
        readonly sizeBytes: number;
      }
    >();
    expectTypeOf<EventOf<'evict'>>().branded.toEqualTypeOf<
      KeyFields<'evict'> & { readonly sizeBytes: number; readonly reason: 'budget' | 'quota' }
    >();
    expectTypeOf<EventOf<'delete'>>().branded.toEqualTypeOf<
      KeyFields<'delete'> & { readonly reason: 'delete' | 'remote' }
    >();
    const promote: CacheEvent = {
      type: 'promote',
      namespace: 'tickets',
      key: 't1',
      tier: 'memory',
      from: 'indexeddb',
      sizeBytes: 40,
    };
    // @ts-expect-error: a promote event needs `from`
    const incomplete: CacheEvent = { type: 'promote', namespace: 'n', key: 'k', tier: 'memory' };

    expect(describeEvent(promote)).toBe('t1: indexeddb -> memory');
    expect(
      describeEvent({ type: 'miss', namespace: 'n', key: 'k', tier: 'session', reason: 'stale' }),
    ).toBe('k: stale');
    expect(describeEvent({ type: 'clear', tier: 'session', reason: 'remote' })).toBe(
      'all namespaces',
    );
    expect(
      describeEvent({ type: 'hit', namespace: 'n', key: 'k', tier: 'memory', sizeBytes: 8 }),
    ).toBe('hit');
    expect(incomplete.type).toBe('promote');
  });
});
