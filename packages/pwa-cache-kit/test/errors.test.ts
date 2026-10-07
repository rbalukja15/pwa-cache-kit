import { describe, expect, expectTypeOf, it } from 'vitest';
import { CacheError, CacheWriteError, type CacheErrorCode } from '../src/index.js';

describe('CacheError', () => {
  it('is an Error with an explicit name, a code and context', () => {
    const cause = new DOMException('full', 'QuotaExceededError');
    const error = new CacheError('QUOTA_EXCEEDED', 'indexeddb is full', {
      cause,
      tier: 'indexeddb',
      namespace: 'tickets',
      key: 't1',
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CacheError');
    expect(String(error)).toBe('CacheError: indexeddb is full');
    expect(error.code).toBe('QUOTA_EXCEEDED');
    expect(error.cause).toBe(cause);
    expect([error.tier, error.namespace, error.key]).toEqual(['indexeddb', 'tickets', 't1']);
  });

  it('has no cause and undefined context when none is given', () => {
    const error = new CacheError('CLOSED', 'cache is closed');

    expect('cause' in error).toBe(false);
    expect([error.tier, error.namespace, error.key]).toEqual([undefined, undefined, undefined]);
  });

  it('keeps an explicitly undefined cause, such as a loader rejecting with undefined', () => {
    const error = new CacheError('LOADER_FAILED', 'reload failed', { cause: undefined });

    expect('cause' in error).toBe(true);
  });

  it('has exactly the codes listed in ADR-0002', () => {
    expectTypeOf<CacheErrorCode>().toEqualTypeOf<
      | 'QUOTA_EXCEEDED'
      | 'ENTRY_TOO_LARGE'
      | 'SERIALIZATION_FAILED'
      | 'STORAGE_FAILED'
      | 'TIER_UNAVAILABLE'
      | 'CORRUPT_ENTRY'
      | 'MIGRATION_FAILED'
      | 'LOADER_FAILED'
      | 'CLOSED'
      | 'WRITE_FAILED'
    >();
  });
});

describe('CacheWriteError', () => {
  it('is a CacheError with code WRITE_FAILED and a frozen copy of the tier errors', () => {
    const quota = new CacheError('QUOTA_EXCEEDED', 'full', { tier: 'indexeddb' });
    const errors = [quota];
    const cause = new Error('aborted');
    const error = new CacheWriteError('set stored nothing', errors, { namespace: 'n', cause });
    errors.pop();

    expect(error).toBeInstanceOf(CacheError);
    expect(error.name).toBe('CacheWriteError');
    expect(String(error)).toBe('CacheWriteError: set stored nothing');
    expect(error.code).toBe('WRITE_FAILED');
    expect(error.errors).toEqual([quota]);
    expect(Object.isFrozen(error.errors)).toBe(true);
    expect(error.namespace).toBe('n');
    expect(error.cause).toBe(cause);
    expectTypeOf(error.code).toEqualTypeOf<'WRITE_FAILED'>();
    expectTypeOf(error.errors).toEqualTypeOf<readonly CacheError[]>();
  });

  it('works without options', () => {
    const error = new CacheWriteError('delete failed', []);

    expect(error.errors).toEqual([]);
    expect('cause' in error).toBe(false);
  });
});
