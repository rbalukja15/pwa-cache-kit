# Ticket Wallet demo

An offline-first ticket wallet built on `@rbalukja/pwa-cache-kit`. After one visit it opens and
shows your tickets without a network connection.

## How it works

- **Data**: `src/tickets.ts` creates a cache with the memory, SessionStorage and IndexedDB tiers
  and loads the ticket list with `getOrSet` from a static JSON "API" (`public/api/tickets.json`).
  The list is fresh for five minutes, then served stale while it is refreshed in the background,
  and kept for as long as the network is away (`staleWhileRevalidateMs: Infinity`).
- **Where it came from**: the page listens to the cache's `hit`, `miss` and `set` events and says
  which tier served the tickets: the network on the first visit, SessionStorage after a reload in
  the same tab, and IndexedDB in a new tab or after a restart.
- **App shell**: `src/sw.ts` is a hand-rolled service worker. The Vite build (`vite.config.ts`)
  writes the names of this build's files into it; it precaches them on install, serves them
  cache-first and drops the caches of older builds on activate. Ticket requests (`api/`) are left
  to the network, since the cache holds the data.
- **Installable**: `public/manifest.webmanifest` with SVG and PNG icons.

The service worker registers only in production builds, so the dev server always runs fresh code.
All URLs are relative, so the build also works below a sub-path.

## Commands

From the repository root:

```sh
npm run build                          # the library, then the demo into demo/dist
npm run preview -w pwa-cache-kit-demo  # serve demo/dist on http://localhost:4174
npm run dev:demo                       # Vite dev server, without the service worker
npm run test:e2e                       # includes demo/e2e/offline.spec.ts
```

To try it offline: open the preview and give the service worker a moment to install, then switch
the browser's network to offline (DevTools, Network) and reload or open a new tab.
