# @rbalukja/pwa-cache-kit

An offline-first cache for Progressive Web Apps that keeps each value in memory, SessionStorage
and IndexedDB, and reads it from the fastest tier that has it. ESM only, typed, no runtime
dependencies.

```sh
npm install @rbalukja/pwa-cache-kit
```

```ts
import { createCache, indexedDBTier, memoryTier } from '@rbalukja/pwa-cache-kit';

const cache = createCache({ name: 'app', tiers: [memoryTier(), indexedDBTier()] });
const tickets = cache.namespace<{ id: string; seat: string }>('tickets', {
  tiers: ['memory', 'indexeddb'],
  ttlMs: 5 * 60_000,
});

await tickets.set('t1', { id: 't1', seat: '12A' });
const ticket = await tickets.get('t1');
```

An in-page inspector that shows each tier's entries and the cache's events ships as a second
entry point, `@rbalukja/pwa-cache-kit/inspector`.

See the [project README](https://github.com/rbalukja15/pwa-cache-kit#readme) for the full guide,
and [ADR-0002](https://github.com/rbalukja15/pwa-cache-kit/blob/main/docs/adr/0002-cache-api-and-semantics.md)
for the API and its semantics.

## License

MIT
