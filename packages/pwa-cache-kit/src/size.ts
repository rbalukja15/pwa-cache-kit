// Size estimate of a value (ADR-0002 section 6). Not exported from index.ts.
import type { CacheValue } from './types.js';

/** Bytes counted for a primitive other than a string, a member, and an object already counted. */
const SLOT = 8;

/**
 * Estimated bytes of a value for budgets when session is not in the policy: strings twice their
 * length, other primitives 8, an `ArrayBuffer` its `byteLength`, a view its buffer's `byteLength`
 * (structured clone copies the whole buffer), a `Blob` its `size`, and arrays, objects, `Map` and
 * `Set` their members (and keys) plus 8 per member. An object reached again (a cycle or a shared
 * reference) counts 8. Iterative, so deep nesting cannot overflow the stack.
 */
export function estimateSize(value: CacheValue): number {
  const seen = new Set<object>();
  const pending: unknown[] = [value];
  let bytes = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === 'string') {
      bytes += 2 * item.length;
    } else if ((typeof item !== 'object' && typeof item !== 'function') || item === null) {
      bytes += SLOT;
    } else if (seen.has(item)) {
      bytes += SLOT;
    } else {
      seen.add(item);
      bytes += members(item, pending);
    }
  }
  return bytes;
}

/**
 * Bytes of an object's own storage; queues its members (and keys) to visit and counts 8 per member.
 * Members are pushed one by one: spreading a large array would exceed the argument limit.
 */
function members(object: object, pending: unknown[]): number {
  if (object instanceof ArrayBuffer) return object.byteLength;
  if (ArrayBuffer.isView(object)) return object.buffer.byteLength;
  if (typeof Blob !== 'undefined' && object instanceof Blob) return object.size;
  if (Array.isArray(object)) {
    for (const member of object as unknown[]) pending.push(member);
    return SLOT * object.length;
  }
  if (object instanceof Map) {
    for (const [key, member] of object) pending.push(key, member);
    return SLOT * object.size;
  }
  if (object instanceof Set) {
    for (const member of object) pending.push(member);
    return SLOT * object.size;
  }
  const keys = Object.keys(object);
  for (const key of keys) pending.push(key, (object as Record<string, unknown>)[key]);
  return SLOT * keys.length;
}
