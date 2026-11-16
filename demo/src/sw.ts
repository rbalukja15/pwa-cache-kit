// Hand-rolled service worker: precaches the app shell of this build and serves it cache-first, so
// the wallet opens offline. Ticket data is not cached here: the app keeps it in pwa-cache-kit.
// The DOM lib is in scope, not the WebWorker one, so the few worker types used are declared here.

interface LifecycleEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface RequestEvent extends LifecycleEvent {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface WorkerScope {
  readonly registration: { readonly scope: string };
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: LifecycleEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: RequestEvent) => void): void;
}

const worker = self as unknown as WorkerScope;

// The demo's Vite plugin (vite.config.ts) replaces the placeholder with the files of this build,
// and the __SHELL_VERSION__ token with a hash of that list.
const PRECACHE = '__PRECACHE_MANIFEST__' as unknown as readonly string[];
const SHELL = 'shell-__SHELL_VERSION__';

const scope = new URL(worker.registration.scope);
const shellUrls = PRECACHE.map((path) => new URL(path, scope).href);

worker.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((shell) => shell.addAll(shellUrls))
      .then(() => worker.skipWaiting()),
  );
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('shell-') && name !== SHELL)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => worker.clients.claim()),
  );
});

worker.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.href.startsWith(scope.href)) return;
  // Data requests go to the network; offline, the app reads its cache instead.
  if (url.href.startsWith(new URL('api/', scope).href)) return;

  // Navigations get the shell whatever their path or query.
  const lookup = request.mode === 'navigate' ? scope.href : request;
  event.respondWith(
    caches
      .open(SHELL)
      .then((shell) => shell.match(lookup, { ignoreSearch: true, ignoreVary: true }))
      .then((cached) => cached ?? fetch(request)),
  );
});
