---
'@rbalukja/pwa-cache-kit': patch
---

Add `getOrSet(key, loader, options?)` to namespaces: read-through caching that joins concurrent
loads of a key, serves stale values within `staleWhileRevalidateMs` while reloading them in the
background, and reports failed background loads as `LOADER_FAILED` errors.
