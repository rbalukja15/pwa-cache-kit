import { describe, expect, it } from 'vitest';
import { estimateSize } from '../src/size.js';

describe('estimateSize', () => {
  it.each([
    ['a string, twice its length', 'abcd', 8],
    ['an empty string', '', 0],
    ['a number', 1.5, 8],
    ['a boolean', true, 8],
    ['null', null, 8],
    ['a bigint', 10n, 8],
    ['a symbol', Symbol('s'), 8],
    ['an ArrayBuffer, its byteLength', new ArrayBuffer(100), 100],
    ['a view, its whole buffer', new Uint8Array(new ArrayBuffer(64), 0, 4), 64],
    ['a DataView, its whole buffer', new DataView(new ArrayBuffer(32)), 32],
    ['a Blob, its size', new Blob(['hello']), 5],
    ['an empty object', {}, 0],
    ['an empty array', [], 0],
  ])('counts %s', (_, value, bytes) => {
    expect(estimateSize(value)).toBe(bytes);
  });

  it('counts members, object keys and 8 per member', () => {
    // 'ab' 4 + 8, then key 'k' 2 + value 8 + 8.
    expect(estimateSize(['ab'])).toBe(12);
    expect(estimateSize({ k: 1 })).toBe(18);
    // [undefined, 1]: 8 + 8 for the members, 8 + 8 for their slots.
    expect(estimateSize([undefined, 1])).toBe(32);
    // Map key 'a' 2 + value 8 + 8; Set member 'bb' 4 + 8.
    expect(estimateSize(new Map([['a', 1]]))).toBe(18);
    expect(estimateSize(new Set(['bb']))).toBe(12);
    expect(estimateSize({ id: 't1', seats: [1, 2], paid: true })).toBe(
      2 * 2 + 4 + 8 + (2 * 5 + (8 + 8 + 8 + 8) + 8) + (2 * 4 + 8 + 8),
    );
  });

  it('counts an object reached again as 8, so cycles terminate', () => {
    const shared = { name: 'Zoë' };
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(estimateSize([shared, shared])).toBe(2 * 8 + (2 * 4 + 6 + 8) + 8);
    expect(estimateSize(cyclic)).toBe(2 * 4 + 8 + 8);
  });

  it('handles nesting deeper than the call stack and arrays longer than the argument limit', () => {
    let deep: unknown[] = [];
    for (let level = 0; level < 100_000; level++) deep = [deep];

    expect(estimateSize(deep)).toBe(100_000 * 8);
    expect(estimateSize(new Array<number>(200_000).fill(1))).toBe(200_000 * 16);
  });
});
