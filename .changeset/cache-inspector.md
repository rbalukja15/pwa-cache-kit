---
'@rbalukja/pwa-cache-kit': patch
---

Add the in-page cache inspector as a separate entry point, `@rbalukja/pwa-cache-kit/inspector`:
`createInspector()` mounts a panel that shows each read with the tier that served it, the keys each
tier holds with their time to live and size, and highlights evictions, all from the cache's events.
