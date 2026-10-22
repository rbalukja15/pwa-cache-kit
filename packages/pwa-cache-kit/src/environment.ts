// Browser context detection (ADR-0002 section 13). Read only inside createCache, never at import.

/** `'window'` or `'worker'` in a browser context, else undefined: the cache is then inert. */
export function browserContext(): 'window' | 'worker' | undefined {
  const scope = globalThis as { window?: unknown; importScripts?: unknown };
  const { window: win } = scope;
  if (typeof win === 'object' && win !== null) {
    const { document } = win as { document?: unknown };
    if (typeof document === 'object' && document !== null) return 'window';
  }
  return typeof scope.importScripts === 'function' ? 'worker' : undefined;
}
