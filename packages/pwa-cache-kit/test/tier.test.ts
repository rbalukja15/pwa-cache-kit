import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  isQuotaError,
  readEnvelope,
  tierBudget,
  type Envelope,
  type TierAdapter,
  type TierResult,
} from '../src/tier.js';

const valid: Envelope = {
  format: 1,
  value: { id: 't1' },
  schemaVersion: 2,
  updatedAt: 1_000,
  freshUntil: 2_000,
  expiresAt: 3_000,
  sizeBytes: 24,
};

describe('readEnvelope', () => {
  it('accepts a valid format-1 envelope, with or without expiry', () => {
    const noExpiry = { format: 1, value: 'v', schemaVersion: 1, updatedAt: 1_000, sizeBytes: 2 };

    expect(readEnvelope(valid)).toBe(valid);
    expect(readEnvelope(noExpiry)).toBe(noExpiry);
    expect(readEnvelope({ ...valid, value: null, sizeBytes: 0 })).toEqual({
      ...valid,
      value: null,
      sizeBytes: 0,
    });
  });

  it('reports a record of a later integer format as newer', () => {
    expect(readEnvelope({ format: 2 })).toBe('newer');
    expect(readEnvelope({ ...valid, format: 7 })).toBe('newer');
  });

  it.each([
    ['null', null],
    ['a string', '{"format":1}'],
    ['an array', [valid]],
    ['no format', { ...valid, format: undefined }],
    ['format 0', { ...valid, format: 0 }],
    ['a fractional format', { ...valid, format: 1.5 }],
    ['a string format', { ...valid, format: '1' }],
    ['no value', { ...valid, value: undefined }],
    ['schemaVersion 0', { ...valid, schemaVersion: 0 }],
    ['a fractional schemaVersion', { ...valid, schemaVersion: 1.5 }],
    ['no updatedAt', { ...valid, updatedAt: undefined }],
    ['a NaN updatedAt', { ...valid, updatedAt: Number.NaN }],
    ['a null freshUntil, as JSON writes Infinity', { ...valid, freshUntil: null }],
    ['an infinite expiresAt', { ...valid, expiresAt: Infinity }],
    ['a negative sizeBytes', { ...valid, sizeBytes: -1 }],
    ['a string sizeBytes', { ...valid, sizeBytes: '24' }],
  ])('reports a record with %s as corrupt', (_, record) => {
    expect(readEnvelope(record)).toBe('corrupt');
  });
});

describe('tierBudget', () => {
  it('defaults maxBytes per tier and maxEntryBytes to a quarter of it', () => {
    const MiB = 1024 * 1024;

    expect(tierBudget('memory')).toEqual({ maxBytes: 8 * MiB, maxEntryBytes: 2 * MiB });
    expect(tierBudget('session')).toEqual({ maxBytes: 2 * MiB, maxEntryBytes: 0.5 * MiB });
    expect(tierBudget('indexeddb', {})).toEqual({ maxBytes: 64 * MiB, maxEntryBytes: 16 * MiB });
    expect(tierBudget('memory', { maxBytes: 100 })).toEqual({ maxBytes: 100, maxEntryBytes: 25 });
    expect(tierBudget('memory', { maxEntryBytes: 1 })).toEqual({
      maxBytes: 8 * MiB,
      maxEntryBytes: 1,
    });
    expect(tierBudget('memory', { maxBytes: 10, maxEntryBytes: 10 })).toEqual({
      maxBytes: 10,
      maxEntryBytes: 10,
    });
  });

  it.each([
    { maxBytes: 0 },
    { maxBytes: -1 },
    { maxBytes: Number.NaN },
    { maxBytes: Infinity },
    { maxEntryBytes: 0 },
    { maxBytes: 10, maxEntryBytes: 11 },
    { maxEntryBytes: 64 * 1024 * 1024 },
    { maxBytes: '100' as unknown as number },
  ])('throws a TypeError for %o', (options) => {
    expect(() => tierBudget('session', options)).toThrow(TypeError);
  });
});

describe('isQuotaError', () => {
  it.each([
    new DOMException('full', 'QuotaExceededError'),
    { name: 'NS_ERROR_DOM_QUOTA_REACHED' },
    { name: 'Error', code: 22 },
    { name: 'Error', code: 1014 },
  ])('recognizes %o', (error) => {
    expect(isQuotaError(error)).toBe(true);
  });

  it.each([
    undefined,
    null,
    'QuotaExceededError',
    new DOMException('gone', 'InvalidStateError'),
    new Error('QuotaExceededError'),
    { name: 'DataCloneError', code: 25 },
  ])('rejects %o', (error) => {
    expect(isQuotaError(error)).toBe(false);
  });
});

describe('TierAdapter types', () => {
  it('returns values when sync, Promises when async, and either for a mixed list', () => {
    expectTypeOf<TierResult<true, string[]>>().toEqualTypeOf<string[]>();
    expectTypeOf<TierResult<false, string[]>>().toEqualTypeOf<Promise<string[]>>();
    expectTypeOf<ReturnType<TierAdapter['keys']>>().toEqualTypeOf<string[] | Promise<string[]>>();
    expectTypeOf<ReturnType<TierAdapter<true>['get']>>().toEqualTypeOf<
      Envelope | 'newer' | undefined
    >();
  });
});
