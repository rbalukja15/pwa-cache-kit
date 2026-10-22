// The orchestrator (ADR-0002 sections 1 to 5, 8, 10, 13 and 15): createCache, namespaces, the
// read and write paths, the per-key queue and the sweep timer.
import { createEmitter } from './emitter.js';
import { browserContext } from './environment.js';
import { CacheError, CacheWriteError } from './errors.js';
import type { CacheEvent } from './events.js';
import { estimateSize } from './size.js';
import { adapterBuilder } from './tier-config.js';
import type { Envelope, TierAdapter, TierEmit } from './tier.js';
import type {
  CacheNamespace,
  CacheValue,
  CreateCache,
  NamespaceOptions,
  SetOptions,
  SetResult,
  TierName,
  TierStatus,
} from './types.js';

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const TIER_ORDER: readonly TierName[] = ['memory', 'session', 'indexeddb'];
const MAX_TIMER_MS = 2 ** 31 - 1;
const DEFAULT_SWEEP_INTERVAL_MS = 300_000;
/** Joins a namespace and a key into a queue id; names cannot contain it. */
const SEPARATOR = '\u0000';

interface Tier {
  readonly name: TierName;
  readonly adapter: TierAdapter;
  /** Last status seen, to emit `TIER_UNAVAILABLE` once when a tier turns unavailable. */
  seen: TierStatus;
}

/** Whether a read of a key may still promote: the key, namespace and cache were not written. */
type Detach = () => boolean;

/** Creates a cache over the given tiers (ADR-0002 section 1). */
export const createCache: CreateCache = (options) => {
  // `broadcast` is checked but unused until cross-context invalidation lands (#24).
  const { name, tiers: configs, sweepIntervalMs } = checkCacheOptions(options);
  const emitter = createEmitter();
  const configured = configs.map((config) => config.name);
  const inert = browserContext() === undefined;

  const emit: TierEmit = Object.assign(
    (event: CacheEvent) => {
      emitter.emit(event);
    },
    { has: (type: CacheEvent['type']) => emitter.has(type) },
  );

  const tiers = new Map<TierName, Tier>();
  if (!inert) {
    for (const config of [...configs].sort(byTierOrder)) {
      const adapter = config.create(name, emit);
      tiers.set(config.name, { name: config.name, adapter, seen: adapter.status });
    }
  }

  let closed = false;
  let cacheEpoch = 0;
  const namespaceEpochs = new Map<string, number>();
  const keyVersions = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();
  const barriers = new Map<string, Promise<void>>();
  let cacheBarrier: Promise<void> = Promise.resolve();

  // --- events -------------------------------------------------------------------------------

  function send(event: CacheEvent): void {
    emitter.emit(event);
  }

  function emitError(error: CacheError): void {
    if (!emitter.has('error')) return;
    const { namespace, key, tier } = error;
    send({ type: 'error', error, ...defined({ namespace, key, tier }) });
  }

  function miss(
    tier: TierName,
    namespace: string,
    key: string,
    reason: Extract<CacheEvent, { type: 'miss' }>['reason'],
  ): void {
    if (emitter.has('miss')) send({ type: 'miss', namespace, key, tier, reason });
  }

  /** Reports tiers that turned unavailable since they were last seen, once each, never inline. */
  function watchStatus(): void {
    for (const tier of tiers.values()) {
      const status = tier.adapter.status;
      if (status === 'unavailable' && tier.seen !== 'unavailable') {
        const error = new CacheError('TIER_UNAVAILABLE', `${tier.name} tier became unavailable`, {
          tier: tier.name,
        });
        queueMicrotask(() => {
          emitError(error);
        });
      }
      tier.seen = status;
    }
  }

  // --- queue and detaching (section 15) -----------------------------------------------------

  function queueId(ns: string, key: string): string {
    return ns + SEPARATOR + key;
  }

  /** Runs an async tier step after the key's earlier steps and any clear queued before it. */
  function enqueue<T>(ns: string, key: string, step: () => Promise<T>): Promise<T> {
    const id = queueId(ns, key);
    const run = Promise.all([queues.get(id), barriers.get(ns), cacheBarrier]).then(step);
    const tail = run.then(ignore, ignore);
    queues.set(id, tail);
    void tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id);
    });
    return run;
  }

  /** Settles once every step queued so far in the namespace, or in the whole cache, has run. */
  function queued(ns?: string): Promise<unknown> {
    const prefix = ns === undefined ? '' : ns + SEPARATOR;
    const tails = [...queues].filter(([id]) => id.startsWith(prefix)).map(([, tail]) => tail);
    const namespaceBarriers = ns === undefined ? [...barriers.values()] : [barriers.get(ns)];
    return Promise.all([...tails, ...namespaceBarriers, cacheBarrier]);
  }

  /** Runs a clear step after the steps queued before it and before the steps queued after it. */
  function enqueueClear(ns: string | undefined, step: () => Promise<void>): Promise<void> {
    const run = queued(ns).then(step);
    const tail = run.then(ignore, ignore);
    if (ns === undefined) cacheBarrier = tail;
    else barriers.set(ns, tail);
    return run;
  }

  /** A check that turns false once the key is written, deleted or cleared, or the cache closed. */
  function detachable(ns: string, key: string): Detach {
    const id = queueId(ns, key);
    const version = keyVersions.get(id);
    const namespaceEpoch = namespaceEpochs.get(ns);
    const epoch = cacheEpoch;
    return () =>
      !closed &&
      keyVersions.get(id) === version &&
      namespaceEpochs.get(ns) === namespaceEpoch &&
      cacheEpoch === epoch;
  }

  function detachKey(ns: string, key: string): void {
    const id = queueId(ns, key);
    keyVersions.set(id, (keyVersions.get(id) ?? 0) + 1);
  }

  function detachNamespace(ns: string): void {
    namespaceEpochs.set(ns, (namespaceEpochs.get(ns) ?? 0) + 1);
  }

  // --- tiers ---------------------------------------------------------------------------------

  function available(names: readonly TierName[]): Tier[] {
    const result: Tier[] = [];
    for (const tierName of TIER_ORDER) {
      const tier = tiers.get(tierName);
      if (tier && names.includes(tierName) && tier.adapter.status !== 'unavailable') {
        result.push(tier);
      }
    }
    return result;
  }

  function failure(error: unknown, tier: TierName, namespace?: string, key?: string): CacheError {
    if (error instanceof CacheError) return error;
    const context = { cause: error, tier, ...defined({ namespace, key }) };
    return new CacheError('STORAGE_FAILED', `${tier} tier: storage operation failed`, context);
  }

  function checkOpen(): void {
    if (closed) throw new CacheError('CLOSED', `cache "${name}" is closed`);
  }

  // --- read path (section 3) -----------------------------------------------------------------

  /**
   * Applies section 3 to what one tier returned: the fresh envelope, `'expired'` when the caller
   * must remove the copy, or undefined after emitting the miss.
   */
  function assess(
    tier: TierName,
    ns: string,
    key: string,
    version: number,
    outcome: { readonly result: Envelope | 'newer' | undefined } | { readonly error: unknown },
  ): Envelope | 'expired' | undefined {
    if ('error' in outcome) {
      const error = failure(outcome.error, tier, ns, key);
      emitError(error);
      miss(tier, ns, key, error.code === 'CORRUPT_ENTRY' ? 'invalid' : 'error');
      return undefined;
    }
    const { result } = outcome;
    if (result === undefined) {
      miss(tier, ns, key, 'absent');
      return undefined;
    }
    if (result === 'newer') {
      miss(tier, ns, key, 'newer');
      return undefined;
    }
    const now = Date.now();
    if (result.expiresAt !== undefined && now >= result.expiresAt) return 'expired';
    if (result.schemaVersion > version) {
      miss(tier, ns, key, 'newer');
      return undefined;
    }
    // Older entries are migrated by #13; until then they are misses, left in place.
    if (result.schemaVersion < version) {
      miss(tier, ns, key, 'invalid');
      return undefined;
    }
    if (result.freshUntil !== undefined && now >= result.freshUntil) {
      miss(tier, ns, key, 'stale');
      return undefined;
    }
    return result;
  }

  /** Emits the events of an expired copy, after the caller tried to remove it. */
  function expired(tier: TierName, ns: string, key: string, removal: unknown): void {
    if (removal !== undefined) emitError(failure(removal, tier, ns, key));
    if (emitter.has('expire')) send({ type: 'expire', namespace: ns, key, tier });
    miss(tier, ns, key, 'expired');
  }

  function readSync(tier: Tier, ns: string, key: string, version: number): Envelope | undefined {
    let outcome;
    try {
      outcome = { result: (tier.adapter as TierAdapter<true>).get(ns, key) };
    } catch (error) {
      outcome = { error };
    }
    const assessed = assess(tier.name, ns, key, version, outcome);
    if (assessed !== 'expired') return assessed;
    let removal: unknown;
    try {
      (tier.adapter as TierAdapter<true>).delete(ns, key);
    } catch (error) {
      removal = error ?? new Error('delete failed');
    }
    expired(tier.name, ns, key, removal);
    return undefined;
  }

  async function readAsync(
    tier: Tier,
    ns: string,
    key: string,
    version: number,
  ): Promise<Envelope | undefined> {
    let outcome;
    try {
      outcome = { result: await tier.adapter.get(ns, key) };
    } catch (error) {
      outcome = { error };
    }
    const assessed = assess(tier.name, ns, key, version, outcome);
    if (assessed !== 'expired') return assessed;
    let removal: unknown;
    try {
      await tier.adapter.delete(ns, key);
    } catch (error) {
      removal = error ?? new Error('delete failed');
    }
    expired(tier.name, ns, key, removal);
    return undefined;
  }

  /** Emits the hit and copies the entry into the walked tiers above it (promotion). */
  function hit(tier: Tier, above: readonly Tier[], ns: string, key: string, envelope: Envelope) {
    if (emitter.has('hit')) {
      const { sizeBytes } = envelope;
      send({ type: 'hit', namespace: ns, key, tier: tier.name, sizeBytes, ...expiry(envelope) });
    }
    const copy: Envelope = { ...envelope, updatedAt: Date.now() };
    for (const target of above) {
      if (!target.adapter.sync) continue;
      try {
        (target.adapter as TierAdapter<true>).set(ns, key, copy);
      } catch (error) {
        const cause = failure(error, target.name, ns, key);
        if (cause.code !== 'ENTRY_TOO_LARGE') emitError(cause);
        continue;
      }
      if (emitter.has('promote')) {
        const { sizeBytes } = copy;
        send({
          type: 'promote',
          namespace: ns,
          key,
          tier: target.name,
          from: tier.name,
          sizeBytes,
          ...expiry(copy),
        });
      }
    }
  }

  function getSync(ns: string, version: number, policy: readonly TierName[], key: string) {
    const walked: Tier[] = [];
    for (const tier of available(policy)) {
      if (!tier.adapter.sync) break;
      const envelope = readSync(tier, ns, key, version);
      if (envelope !== undefined) {
        hit(tier, walked, ns, key, envelope);
        return envelope.value;
      }
      walked.push(tier);
    }
    return undefined;
  }

  async function get(ns: string, version: number, policy: readonly TierName[], key: string) {
    const isAttached = detachable(ns, key);
    const walked: Tier[] = [];
    for (const tier of available(policy)) {
      const envelope = tier.adapter.sync
        ? readSync(tier, ns, key, version)
        : await enqueue(ns, key, () => readAsync(tier, ns, key, version));
      if (envelope !== undefined) {
        // A detached read returns its value but promotes nothing (section 15).
        hit(tier, isAttached() ? walked : [], ns, key, envelope);
        return envelope.value;
      }
      walked.push(tier);
    }
    return undefined;
  }

  // --- write path (section 4) ----------------------------------------------------------------

  async function set(
    ns: string,
    defaults: Required<SetOptions> & { readonly version: number },
    policy: readonly TierName[],
    key: string,
    value: CacheValue,
    options: SetOptions | undefined,
  ): Promise<SetResult> {
    const { ttlMs, staleWhileRevalidateMs } = checkSetOptions(options, defaults);
    let sizeBytes: number;
    if (policy.includes('session')) {
      // Typed unknown: JSON.stringify returns undefined for a function or symbol.
      let json: unknown;
      try {
        json = JSON.stringify(value);
      } catch (cause) {
        throw new TypeError('set: a value in a session namespace must be JSON-safe', { cause });
      }
      if (typeof json !== 'string') {
        throw new TypeError('set: a value in a session namespace must be JSON-safe');
      }
      sizeBytes = 2 * json.length;
    } else {
      sizeBytes = estimateSize(value);
    }
    const now = Date.now();
    const freshUntil = now + ttlMs;
    const expiresAt = freshUntil + staleWhileRevalidateMs;
    const envelope: Envelope = {
      format: 1,
      value,
      schemaVersion: defaults.version,
      updatedAt: now,
      sizeBytes,
      ...(Number.isFinite(freshUntil) ? { freshUntil } : {}),
      ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
    };
    if (inert) return { stored: [], errors: [] };

    detachKey(ns, key);
    const outcomes: (TierName | CacheError | Promise<TierName | CacheError>)[] = [];
    for (const tier of available(policy)) {
      outcomes.push(
        tier.adapter.sync
          ? writeSync(tier, ns, key, envelope)
          : enqueue(ns, key, () => writeAsync(tier, ns, key, envelope)),
      );
    }
    const stored: TierName[] = [];
    const errors: CacheError[] = [];
    for (const outcome of outcomes) {
      const settled = await outcome;
      if (settled instanceof CacheError) errors.push(settled);
      else stored.push(settled);
    }
    watchStatus();
    if (stored.length === 0 && errors.length > 0) {
      throw new CacheWriteError(`set failed in every tier for "${key}"`, errors, {
        namespace: ns,
        key,
      });
    }
    return { stored, errors };
  }

  function written(tier: Tier, ns: string, key: string, envelope: Envelope): TierName {
    if (emitter.has('set')) {
      const { sizeBytes } = envelope;
      send({
        type: 'set',
        namespace: ns,
        key,
        tier: tier.name,
        sizeBytes,
        reason: 'set',
        ...expiry(envelope),
      });
    }
    return tier.name;
  }

  function writeSync(tier: Tier, ns: string, key: string, envelope: Envelope) {
    const adapter = tier.adapter as TierAdapter<true>;
    try {
      adapter.set(ns, key, envelope);
    } catch (error) {
      // The tier must not keep serving an older value (section 4), best effort.
      try {
        adapter.delete(ns, key);
      } catch {
        // Best effort.
      }
      const cause = failure(error, tier.name, ns, key);
      emitError(cause);
      return cause;
    }
    return written(tier, ns, key, envelope);
  }

  async function writeAsync(tier: Tier, ns: string, key: string, envelope: Envelope) {
    try {
      await tier.adapter.set(ns, key, envelope);
    } catch (error) {
      await Promise.resolve(tier.adapter.delete(ns, key)).catch(ignore);
      const cause = failure(error, tier.name, ns, key);
      emitError(cause);
      return cause;
    }
    return written(tier, ns, key, envelope);
  }

  /** Runs one removal per tier: sync ones now, async ones queued; collects the failures. */
  async function removeEverywhere(
    targets: readonly Tier[],
    run: (tier: Tier) => void | Promise<void>,
    queue: (tier: Tier) => Promise<void>,
    context: { readonly namespace?: string; readonly key?: string },
    done: (tier: Tier) => void,
  ): Promise<void> {
    const outcomes: (CacheError | undefined | Promise<CacheError | undefined>)[] = [];
    for (const tier of targets) {
      const fail = (error: unknown) => {
        const cause = failure(error, tier.name, context.namespace, context.key);
        emitError(cause);
        return cause;
      };
      if (tier.adapter.sync) {
        try {
          void run(tier);
          done(tier);
          outcomes.push(undefined);
        } catch (error) {
          outcomes.push(fail(error));
        }
      } else {
        outcomes.push(
          queue(tier).then(
            () => {
              done(tier);
              return undefined;
            },
            (error: unknown) => fail(error),
          ),
        );
      }
    }
    const errors: CacheError[] = [];
    for (const outcome of outcomes) {
      const settled = await outcome;
      if (settled) errors.push(settled);
    }
    watchStatus();
    if (errors.length > 0) {
      throw new CacheWriteError('removal failed in a tier', errors, defined(context));
    }
  }

  function remove(ns: string, policy: readonly TierName[], key: string): Promise<void> {
    if (inert) return Promise.resolve();
    detachKey(ns, key);
    return removeEverywhere(
      available(policy),
      (tier) => tier.adapter.delete(ns, key),
      (tier) => enqueue(ns, key, async () => tier.adapter.delete(ns, key)),
      { namespace: ns, key },
      (tier) => {
        if (emitter.has('delete')) {
          send({ type: 'delete', namespace: ns, key, tier: tier.name, reason: 'delete' });
        }
      },
    );
  }

  function clear(ns?: string): Promise<void> {
    if (inert) return Promise.resolve();
    if (ns === undefined) cacheEpoch++;
    else detachNamespace(ns);
    return removeEverywhere(
      available(configured),
      (tier) => tier.adapter.clear(ns),
      (tier) => enqueueClear(ns, async () => tier.adapter.clear(ns)),
      ns === undefined ? {} : { namespace: ns },
      (tier) => {
        if (emitter.has('clear')) {
          send({ type: 'clear', tier: tier.name, reason: 'clear', ...defined({ namespace: ns }) });
        }
      },
    );
  }

  async function keys(ns: string, policy: readonly TierName[]): Promise<string[]> {
    if (inert) return [];
    const found = new Set<string>();
    for (const tier of available(policy)) {
      try {
        if (!tier.adapter.sync) await queued(ns);
        for (const key of await tier.adapter.keys(ns)) found.add(key);
      } catch (error) {
        emitError(failure(error, tier.name, ns));
      }
    }
    watchStatus();
    return [...found];
  }

  // --- sweep (sections 8 and 17) -------------------------------------------------------------

  function sweep(): void {
    if (closed) return;
    for (const tier of tiers.values()) {
      if (!tier.adapter.sweep || tier.adapter.status === 'unavailable') continue;
      const report = (error: unknown) => {
        emitError(failure(error, tier.name));
      };
      try {
        void Promise.resolve(tier.adapter.sweep()).catch(report).then(watchStatus);
      } catch (error) {
        report(error);
      }
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  if ([...tiers.values()].some((tier) => tier.adapter.sweep !== undefined)) {
    // After this call returns, so handlers registered right after createCache see its events.
    queueMicrotask(sweep);
    if (sweepIntervalMs > 0) timer = setInterval(sweep, sweepIntervalMs);
  }

  // --- public objects ------------------------------------------------------------------------

  function namespace<V extends CacheValue = CacheValue>(
    nsName: string,
    nsOptions: NamespaceOptions,
  ): CacheNamespace<V> {
    const { policy, ...defaults } = checkNamespaceOptions(nsName, nsOptions, configured);
    const { version } = defaults;

    return {
      name: nsName,
      get: (key) =>
        attempt(async () => {
          checkKey('get', key);
          checkOpen();
          if (inert) return undefined;
          const value = await get(nsName, version, policy, key);
          watchStatus();
          return value as V | undefined;
        }),
      getSync(key) {
        checkKey('getSync', key);
        checkOpen();
        if (inert) return undefined;
        return getSync(nsName, version, policy, key) as V | undefined;
      },
      has: (key) =>
        attempt(async () => {
          checkKey('has', key);
          checkOpen();
          if (inert) return false;
          return (await get(nsName, version, policy, key)) !== undefined;
        }),
      set: (key, value, options) =>
        attempt(() => {
          checkKey('set', key);
          checkValue(value);
          checkOpen();
          return set(nsName, defaults, policy, key, value, options);
        }),
      delete: (key) =>
        attempt(() => {
          checkKey('delete', key);
          checkOpen();
          return remove(nsName, policy, key);
        }),
      keys: () =>
        attempt(() => {
          checkOpen();
          return keys(nsName, policy);
        }),
      clear: () =>
        attempt(() => {
          checkOpen();
          return clear(nsName);
        }),
      getOrSet: () => Promise.reject(new Error('getOrSet is not implemented yet (#25)')),
    };
  }

  return {
    name,
    namespace,
    on: (type, handler) => emitter.on(type, handler),
    off: (type, handler) => {
      emitter.off(type, handler);
    },
    status() {
      const result: Partial<Record<TierName, TierStatus>> = {};
      for (const tierName of configured) {
        result[tierName] = tiers.get(tierName)?.adapter.status ?? 'unavailable';
      }
      watchStatus();
      return result;
    },
    clear: () =>
      attempt(() => {
        checkOpen();
        return clear();
      }),
    close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      const waiting: Tier[] = [];
      for (const tier of tiers.values()) {
        if (tier.adapter.sync) tier.adapter.close();
        else waiting.push(tier);
      }
      if (waiting.length > 0) {
        void queued().then(() => {
          for (const tier of waiting) tier.adapter.close();
        });
      }
    },
  };
};

// --- validation ------------------------------------------------------------------------------

interface CheckedTier {
  readonly name: TierName;
  readonly create: NonNullable<ReturnType<typeof adapterBuilder>>;
}

function checkCacheOptions(options: unknown) {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('createCache: options must be an object');
  }
  const { name, tiers, sweepIntervalMs, broadcast } = options as Record<string, unknown>;
  checkName('createCache', name);
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new TypeError('createCache: tiers must be a non-empty array');
  }
  const checked: CheckedTier[] = [];
  for (const config of tiers as unknown[]) {
    const create = adapterBuilder(config);
    if (create === undefined) {
      throw new TypeError('createCache: every tier must come from a tier factory');
    }
    const tierName = (config as { name: TierName }).name;
    if (checked.some((tier) => tier.name === tierName)) {
      throw new TypeError(`createCache: duplicate tier "${tierName}"`);
    }
    checked.push({ name: tierName, create });
  }
  const interval = sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  if (interval !== 0 && !isIntegerIn(interval, 1, MAX_TIMER_MS)) {
    throw new TypeError('createCache: sweepIntervalMs must be 0 or an integer from 1 to 2^31 - 1');
  }
  if (broadcast !== undefined && typeof broadcast !== 'boolean') {
    throw new TypeError('createCache: broadcast must be a boolean');
  }
  return {
    name,
    tiers: checked,
    sweepIntervalMs: interval,
    broadcast: broadcast ?? true,
  };
}

function checkNamespaceOptions(name: unknown, options: unknown, configured: readonly TierName[]) {
  checkName('namespace', name);
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('namespace: options must be an object');
  }
  const { tiers, ttlMs, staleWhileRevalidateMs, version, migrations } = options as Record<
    string,
    unknown
  >;
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new TypeError('namespace: tiers must be a non-empty array');
  }
  const policy: TierName[] = [];
  for (const tier of tiers as unknown[]) {
    if (!configured.includes(tier as TierName)) {
      throw new TypeError(`namespace: tier "${String(tier)}" is not one of the cache's tiers`);
    }
    if (policy.includes(tier as TierName)) {
      throw new TypeError(`namespace: duplicate tier "${String(tier)}"`);
    }
    policy.push(tier as TierName);
  }
  const expiry = checkSetOptions({ ttlMs, staleWhileRevalidateMs }, undefined, 'namespace');
  if (version !== undefined && !isIntegerIn(version, 1, Number.MAX_SAFE_INTEGER)) {
    throw new TypeError('namespace: version must be an integer from 1');
  }
  if (migrations !== undefined && (typeof migrations !== 'object' || migrations === null)) {
    throw new TypeError('namespace: migrations must be an object');
  }
  return { policy, ...expiry, version: version ?? 1 };
}

/** JavaScript callers can pass undefined, which no tier can store. */
function checkValue(value: unknown): void {
  if (value === undefined) throw new TypeError('set: value must not be undefined');
}

function checkSetOptions(
  options: unknown,
  defaults: Required<SetOptions> | undefined,
  caller = 'set',
): Required<SetOptions> {
  if (options !== undefined && (typeof options !== 'object' || options === null)) {
    throw new TypeError(`${caller}: options must be an object`);
  }
  const { ttlMs, staleWhileRevalidateMs } = (options ?? {}) as Record<string, unknown>;
  // Only undefined means "not given"; null is an invalid value like any other.
  const ttl = ttlMs === undefined ? (defaults?.ttlMs ?? Infinity) : ttlMs;
  const swr =
    staleWhileRevalidateMs === undefined
      ? (defaults?.staleWhileRevalidateMs ?? 0)
      : staleWhileRevalidateMs;
  if (typeof ttl !== 'number' || !(ttl > 0)) {
    throw new TypeError(`${caller}: ttlMs must be a positive number or Infinity`);
  }
  if (typeof swr !== 'number' || !(swr >= 0)) {
    throw new TypeError(`${caller}: staleWhileRevalidateMs must be non-negative or Infinity`);
  }
  return { ttlMs: ttl, staleWhileRevalidateMs: swr };
}

function checkName(caller: string, name: unknown): asserts name is string {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new TypeError(`${caller}: name must match ${String(NAME)}`);
  }
}

function checkKey(caller: string, key: unknown): asserts key is string {
  if (typeof key !== 'string') throw new TypeError(`${caller}: key must be a string`);
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

// --- helpers ---------------------------------------------------------------------------------

/** Runs a call so that its synchronous throws become rejections (section 2). */
async function attempt<T>(call: () => T | Promise<T>): Promise<T> {
  return call();
}

function byTierOrder(a: { name: TierName }, b: { name: TierName }): number {
  return TIER_ORDER.indexOf(a.name) - TIER_ORDER.indexOf(b.name);
}

function expiry(envelope: Envelope): { freshUntil?: number; expiresAt?: number } {
  return defined({ freshUntil: envelope.freshUntil, expiresAt: envelope.expiresAt });
}

/** The object without its undefined properties, so payloads only carry what is known. */
function defined<T extends object>(object: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

function ignore(): void {
  // Settles a queue tail whatever the step did.
}
