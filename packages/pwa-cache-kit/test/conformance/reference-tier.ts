// A small reference tier that follows the adapter contract. It proves the conformance suite in CI
// and stands in for a real tier in the orchestrator's tests (#7) until those tiers exist.
import { CacheError, type CacheErrorCode } from '../../src/errors.js';
import {
  isQuotaError,
  readEnvelope,
  tierBudget,
  type CreateTierAdapter,
  type Envelope,
  type TierAdapter,
  type TierBudget,
  type TierEmit,
} from '../../src/tier.js';
import type { TierName, TierOptions, TierStatus } from '../../src/types.js';
import type { TierHarness } from './tier-conformance.js';

/** Raw records of one cache: namespace, then key, then whatever was written. */
type Records = Map<string, Map<string, unknown>>;

interface Stored {
  readonly ns: string;
  readonly key: string;
  readonly envelope: Envelope;
}

/**
 * A reference tier named `name`. Sync, it evicts within `set` like memory and session; async, it
 * opens on a later microtask and evicts in `sweep` like IndexedDB. Its records outlive adapters, as
 * persistent storage does: adapters of the same cache name share them until `reset`.
 */
export function createReferenceTier<Sync extends boolean>(
  name: TierName,
  sync: Sync,
): Omit<TierHarness<Sync>, 'name'> {
  const storage = new Map<string, Records>();
  let failingWrites = 0;

  function recordsOf(cacheName: string): Records {
    let records = storage.get(cacheName);
    if (!records) {
      records = new Map();
      storage.set(cacheName, records);
    }
    return records;
  }

  function write(records: Records, ns: string, key: string, record: unknown): void {
    if (failingWrites > 0) {
      failingWrites--;
      throw new DOMException('Simulated quota error', 'QuotaExceededError');
    }
    put(records, ns, key, record);
  }

  return {
    tier(options?: TierOptions): CreateTierAdapter<Sync> {
      const budget = tierBudget(name, options);
      return (cacheName, emit) => {
        const records = recordsOf(cacheName);
        const core = createCore(name, records, budget, emit, (ns, key, envelope) => {
          write(records, ns, key, envelope);
        });
        return (sync ? syncAdapter(core) : asyncAdapter(core)) as TierAdapter<Sync>;
      };
    },
    failWrites(count) {
      failingWrites = count;
    },
    writeRaw(cacheName, ns, key, kind) {
      const record =
        kind === 'newer'
          ? { format: 2, payload: 'written by a later version' }
          : { format: 1, value: 'no schemaVersion, updatedAt or sizeBytes' };
      put(recordsOf(cacheName), ns, key, record);
    },
    reset() {
      storage.clear();
      failingWrites = 0;
    },
  };
}

function put(records: Records, ns: string, key: string, record: unknown): void {
  let keys = records.get(ns);
  if (!keys) {
    keys = new Map();
    records.set(ns, keys);
  }
  keys.set(key, record);
}

/** The tier's behavior as sync functions; the adapters below give it a sync or async shape. */
interface Core {
  readonly name: TierName;
  get(ns: string, key: string): Envelope | 'newer' | undefined;
  /** Stores the envelope; with `enforceBudget`, also evicts down to `maxBytes`. */
  set(ns: string, key: string, envelope: Envelope, enforceBudget: boolean): void;
  delete(ns: string, key: string): void;
  clear(ns?: string): void;
  keys(ns: string): string[];
  sweep(): void;
}

function createCore(
  name: TierName,
  records: Records,
  budget: TierBudget,
  emit: TierEmit,
  write: (ns: string, key: string, envelope: Envelope) => void,
): Core {
  function error(code: CacheErrorCode, message: string, ns: string, key: string, cause?: unknown) {
    const context = { tier: name, namespace: ns, key };
    const options = cause === undefined ? context : { ...context, cause };
    return new CacheError(code, `${name} tier: ${message}`, options);
  }

  function remove(ns: string, key: string): void {
    const keys = records.get(ns);
    keys?.delete(key);
    if (keys?.size === 0) records.delete(ns);
  }

  function entries(): Stored[] {
    const stored: Stored[] = [];
    for (const [ns, keys] of records) {
      for (const [key, record] of keys) {
        const envelope = readEnvelope(record);
        if (typeof envelope === 'object') stored.push({ ns, key, envelope });
      }
    }
    return stored;
  }

  function isExpired({ envelope }: Stored, now: number): boolean {
    return envelope.expiresAt !== undefined && envelope.expiresAt <= now;
  }

  function removeEntry(entry: Stored, now: number, reason: 'budget' | 'quota'): void {
    remove(entry.ns, entry.key);
    const { ns: namespace, key, envelope } = entry;
    if (isExpired(entry, now)) emit({ type: 'expire', namespace, key, tier: name });
    else emit({ type: 'evict', namespace, key, tier: name, sizeBytes: envelope.sizeBytes, reason });
  }

  /** Removes expired entries first, then the least recently written, until `bytes` are freed. */
  function evict(bytes: number, reason: 'budget' | 'quota', spare?: { ns: string; key: string }) {
    const now = Date.now();
    const candidates = entries()
      .filter((entry) => !(entry.ns === spare?.ns && entry.key === spare.key))
      .sort(
        (a, b) =>
          Number(isExpired(b, now)) - Number(isExpired(a, now)) ||
          a.envelope.updatedAt - b.envelope.updatedAt,
      );
    let freed = 0;
    for (const entry of candidates) {
      if (freed >= bytes) return;
      removeEntry(entry, now, reason);
      freed += entry.envelope.sizeBytes;
    }
  }

  function enforceBudget(spare?: { ns: string; key: string }): void {
    const usage = entries().reduce((sum, entry) => sum + entry.envelope.sizeBytes, 0);
    if (usage > budget.maxBytes) evict(usage - budget.maxBytes, 'budget', spare);
  }

  return {
    name,
    get(ns, key) {
      const record = records.get(ns)?.get(key);
      if (record === undefined) return undefined;
      const envelope = readEnvelope(record);
      if (envelope !== 'corrupt') return envelope;
      remove(ns, key);
      throw error('CORRUPT_ENTRY', 'removed a record that is not a valid envelope', ns, key);
    },
    set(ns, key, envelope, enforce) {
      if (envelope.sizeBytes > budget.maxEntryBytes) {
        const sizes = `${String(envelope.sizeBytes)} > ${String(budget.maxEntryBytes)} bytes`;
        throw error('ENTRY_TOO_LARGE', `entry above maxEntryBytes (${sizes})`, ns, key);
      }
      try {
        write(ns, key, envelope);
      } catch (cause) {
        if (!isQuotaError(cause)) throw error('STORAGE_FAILED', 'write failed', ns, key, cause);
        evict(envelope.sizeBytes, 'quota', { ns, key });
        try {
          write(ns, key, envelope);
        } catch (retryCause) {
          const code = isQuotaError(retryCause) ? 'QUOTA_EXCEEDED' : 'STORAGE_FAILED';
          throw error(code, 'write failed after making room', ns, key, retryCause);
        }
      }
      if (enforce) enforceBudget({ ns, key });
    },
    delete: remove,
    clear(ns) {
      if (ns === undefined) records.clear();
      else records.delete(ns);
    },
    keys(ns) {
      return [...(records.get(ns)?.keys() ?? [])];
    },
    sweep() {
      const now = Date.now();
      for (const entry of entries()) {
        if (isExpired(entry, now)) removeEntry(entry, now, 'budget');
      }
      enforceBudget();
    },
  };
}

function syncAdapter(core: Core): TierAdapter<true> {
  return {
    name: core.name,
    sync: true,
    status: 'available',
    get: (ns, key) => core.get(ns, key),
    set: (ns, key, envelope) => {
      core.set(ns, key, envelope, true);
    },
    delete: (ns, key) => {
      core.delete(ns, key);
    },
    clear: (ns) => {
      core.clear(ns);
    },
    keys: (ns) => core.keys(ns),
    close: () => undefined,
  };
}

function asyncAdapter(core: Core): TierAdapter<false> {
  let status: TierStatus = 'pending';
  const opened = Promise.resolve().then(() => {
    status = 'available';
  });
  return {
    name: core.name,
    sync: false,
    get status() {
      return status;
    },
    get: async (ns, key) => {
      await opened;
      return core.get(ns, key);
    },
    set: async (ns, key, envelope) => {
      await opened;
      core.set(ns, key, envelope, false);
    },
    delete: async (ns, key) => {
      await opened;
      core.delete(ns, key);
    },
    clear: async (ns) => {
      await opened;
      core.clear(ns);
    },
    keys: async (ns) => {
      await opened;
      return core.keys(ns);
    },
    sweep: async () => {
      await opened;
      core.sweep();
    },
    close: () => undefined,
  };
}
