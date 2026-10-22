// Event dispatch for one cache (ADR-0002 section 11).
import type { CacheEvent, CacheEventHandler, CacheEventType } from './events.js';

type AnyHandler = (event: CacheEvent) => void;

/** A cache's handlers: synchronous dispatch in registration order, each once per type. */
export interface Emitter {
  /** Whether any handler listens for `type`; callers build no payload otherwise. */
  has(type: CacheEventType): boolean;
  emit(event: CacheEvent): void;
  on<T extends CacheEventType>(type: T, handler: CacheEventHandler<T>): () => void;
  off<T extends CacheEventType>(type: T, handler: CacheEventHandler<T>): void;
}

export function createEmitter(): Emitter {
  const handlers = new Map<CacheEventType, Set<AnyHandler>>();

  function off(type: CacheEventType, handler: AnyHandler): void {
    const set = handlers.get(type);
    set?.delete(handler);
    if (set?.size === 0) handlers.delete(type);
  }

  return {
    has: (type) => handlers.has(type),
    emit(event) {
      const set = handlers.get(event.type);
      if (!set) return;
      // A copy, so handlers added or removed during dispatch take effect from the next event.
      for (const handler of [...set]) {
        try {
          handler(event);
        } catch (error) {
          report(error);
        }
      }
    },
    on(type, handler) {
      if (typeof handler !== 'function') throw new TypeError('on: handler must be a function');
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler as AnyHandler);
      return () => {
        off(type, handler as AnyHandler);
      };
    },
    off(type, handler) {
      off(type, handler as AnyHandler);
    },
  };
}

/** Reports a throwing handler without breaking the operation that emitted. */
function report(error: unknown): void {
  if (typeof globalThis.reportError === 'function') {
    globalThis.reportError(error);
  } else {
    setTimeout(() => {
      throw error;
    });
  }
}
