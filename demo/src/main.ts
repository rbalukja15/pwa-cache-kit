import type { TieredCache, TierName } from '@rbalukja/pwa-cache-kit';
import { createInspector } from '@rbalukja/pwa-cache-kit/inspector';
import './style.css';
import { fetchTickets, LIST_KEY, openWallet, type Ticket, type Wallet } from './tickets.js';

const TIER_LABELS: Record<TierName, string> = {
  memory: 'memory',
  session: 'SessionStorage',
  indexeddb: 'IndexedDB',
};

function element(testId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`missing element ${testId}`);
  return found;
}

const list = element('tickets');
const source = element('source');
const connection = element('connection');
const refresh = element('refresh') as HTMLButtonElement;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

let wallet: Wallet = openWallet(false);

function render(tickets: readonly Ticket[]): void {
  list.replaceChildren(
    ...tickets.map((ticket) => {
      const item = document.createElement('li');
      item.className = 'ticket';
      item.dataset['testid'] = 'ticket';
      const title = document.createElement('h2');
      title.textContent = ticket.event;
      const details = document.createElement('p');
      details.textContent = `${ticket.venue} · ${dateFormat.format(new Date(ticket.startsAt))}`;
      const seat = document.createElement('p');
      seat.className = 'seat';
      seat.textContent = `${ticket.section} · Seat ${ticket.seat}`;
      const code = document.createElement('code');
      code.hidden = true;
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'show-code';
      show.dataset['testid'] = 'show-code';
      show.textContent = 'Show code';
      // Each ticket is its own cache entry, so opening one is a read the inspector shows.
      show.addEventListener('click', () => {
        void wallet.tickets
          .getOrSet(ticket.id, () => ticket)
          .then((stored) => {
            code.textContent = stored.code;
            code.hidden = false;
            show.hidden = true;
          });
      });
      item.append(title, details, seat, show, code);
      return item;
    }),
  );
}

// The cache's events say where each read was served from, as they do for the inspector.
const read: { servedBy?: string; offline?: boolean } = {};
/** Read through a call: the handlers set the field during the awaits, out of the checker's view. */
const servedBy = (): string | undefined => read.servedBy;
const wentOffline = (): boolean => read.offline === true;
const OFFLINE_NOTE = 'Offline: showing your saved tickets.';

function watch(cache: TieredCache): void {
  cache.on('hit', (event) => {
    if (event.key === LIST_KEY) read.servedBy = `Served from ${TIER_LABELS[event.tier]}.`;
  });
  cache.on('miss', (event) => {
    if (event.key === LIST_KEY && event.reason === 'stale') {
      read.servedBy = `Served a saved copy from ${TIER_LABELS[event.tier]}; refreshing in the background.`;
    }
  });
  cache.on('set', (event) => {
    if (event.key === LIST_KEY && event.reason === 'load' && event.tier === 'memory') {
      read.servedBy = 'Loaded from the network.';
    }
  });
  cache.on('error', (event) => {
    if (event.error.code === 'LOADER_FAILED') {
      // The background refresh can fail before or after load() writes its message.
      read.offline = true;
      source.textContent = OFFLINE_NOTE;
    } else {
      console.warn(event.error);
    }
  });
}

/** Keeps each ticket under its own key too, so opening one works offline. */
async function cacheEach(tickets: readonly Ticket[]): Promise<void> {
  for (const ticket of tickets) await wallet.tickets.set(ticket.id, ticket).catch(ignore);
}

async function load(): Promise<void> {
  delete read.servedBy;
  delete read.offline;
  try {
    const tickets = await wallet.list.getOrSet(LIST_KEY, fetchTickets);
    render(tickets);
    source.textContent = wentOffline() ? OFFLINE_NOTE : (servedBy() ?? 'Ready.');
    await cacheEach(tickets);
  } catch {
    list.replaceChildren();
    source.textContent = 'You are offline and no tickets are saved on this device yet.';
  }
}

refresh.addEventListener('click', () => {
  void (async () => {
    refresh.disabled = true;
    try {
      const tickets = await fetchTickets();
      await wallet.list.set(LIST_KEY, tickets);
      render(tickets);
      source.textContent = 'Refreshed from the network.';
      await cacheEach(tickets);
    } catch {
      source.textContent = 'Could not reach the network; keeping your saved tickets.';
    } finally {
      refresh.disabled = false;
    }
  })();
});

function showConnection(): void {
  connection.textContent = navigator.onLine ? 'Online' : 'Offline';
  connection.dataset['state'] = navigator.onLine ? 'online' : 'offline';
}
window.addEventListener('online', showConnection);
window.addEventListener('offline', showConnection);
showConnection();

// The inspector reads the cache through its events only. Its pressure switch reopens the cache
// with small budgets, then loads again, so the writes and the IndexedDB sweep evict.
const inspector = createInspector({
  collapsed: window.matchMedia('(max-width: 40rem)').matches,
  onPressureChange(pressure) {
    wallet.cache.close();
    wallet = openWallet(pressure);
    watch(wallet.cache);
    inspector.attach(wallet.cache);
    void load();
  },
});
watch(wallet.cache);
inspector.attach(wallet.cache);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((error: unknown) => {
    console.warn('service worker registration failed', error);
  });
}

void load();

function ignore(): void {
  // A ticket that does not fit is still shown; the inspector reports why.
}
