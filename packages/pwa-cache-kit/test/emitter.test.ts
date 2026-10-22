import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmitter } from '../src/emitter.js';
import type { CacheEvent } from '../src/events.js';

const miss: CacheEvent = {
  type: 'miss',
  namespace: 'n',
  key: 'k',
  tier: 'memory',
  reason: 'absent',
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('emitter', () => {
  it('calls handlers in registration order, once each, for their type only', () => {
    const emitter = createEmitter();
    const calls: string[] = [];
    const first = () => calls.push('first');
    emitter.on('miss', first);
    emitter.on('miss', first);
    emitter.on('miss', () => calls.push('second'));
    emitter.on('hit', () => calls.push('hit'));

    emitter.emit(miss);

    expect(calls).toEqual(['first', 'second']);
    expect(emitter.has('miss')).toBe(true);
    expect(emitter.has('set')).toBe(false);
  });

  it('applies handlers added or removed during dispatch from the next event', () => {
    const emitter = createEmitter();
    const late = vi.fn();
    const removed = vi.fn();
    emitter.on('miss', () => {
      emitter.on('miss', late);
      emitter.off('miss', removed);
    });
    emitter.on('miss', removed);

    emitter.emit(miss);
    expect(late).not.toHaveBeenCalled();
    expect(removed).toHaveBeenCalledTimes(1);

    emitter.emit(miss);
    expect(late).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('forgets a type once its last handler is removed', () => {
    const emitter = createEmitter();
    const unsubscribe = emitter.on('miss', () => undefined);
    unsubscribe();
    emitter.off('miss', () => undefined);
    expect(emitter.has('miss')).toBe(false);
    expect(() => {
      emitter.emit(miss);
    }).not.toThrow();
  });

  it('rejects a handler that is not a function', () => {
    expect(() => createEmitter().on('miss', 'handler' as never)).toThrow(TypeError);
  });

  it('reports a throwing handler with reportError and keeps dispatching', () => {
    const reportError = vi.fn();
    vi.stubGlobal('reportError', reportError);
    const emitter = createEmitter();
    const after = vi.fn();
    const error = new Error('handler broke');
    emitter.on('miss', () => {
      throw error;
    });
    emitter.on('miss', after);

    emitter.emit(miss);

    expect(reportError).toHaveBeenCalledWith(error);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('rethrows from a timer when reportError is missing', () => {
    vi.stubGlobal('reportError', undefined);
    vi.useFakeTimers();
    const emitter = createEmitter();
    emitter.on('miss', () => {
      throw new Error('handler broke');
    });

    emitter.emit(miss);

    expect(() => vi.runAllTimers()).toThrow('handler broke');
  });
});
